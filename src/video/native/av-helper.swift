// av-helper: on-device video signals from Apple's Vision and SoundAnalysis frameworks.
// Each mode prints one JSON document to stdout. Logs go to stderr.
//
//   av-helper motion <frame1> <frame2> ...   camera and subject motion between consecutive frames
//   av-helper pose <image> ...               human body poses per image
//   av-helper ocr <image> ...                recognized text lines per image
//   av-helper sounds <audio file>            SoundAnalysis labels per window

import CoreImage
import Foundation
import ImageIO
import SoundAnalysis
import Vision

func fail(_ message: String) -> Never {
	FileHandle.standardError.write("av-helper: \(message)\n".data(using: .utf8)!)
	exit(1)
}

func emit(_ value: Any) {
	guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
		fail("could not encode output")
	}
	FileHandle.standardOutput.write(data)
	FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func loadImage(_ path: String) -> CGImage {
	guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
		let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
	else { fail("cannot read image \(path)") }
	return img
}

func round3(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }

// MARK: motion

/// Solves a 3x3 linear system by Cramer's rule. Nil when the matrix is singular.
func solve3(_ m: [[Double]], _ b: [Double]) -> [Double]? {
	func det(_ a: [[Double]]) -> Double {
		a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
			+ a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
	}
	let d = det(m)
	if abs(d) < 1e-12 { return nil }
	return (0..<3).map { c in
		var mc = m
		for r in 0..<3 { mc[r][c] = b[r] }
		return det(mc) / d
	}
}

/// Flow vectors are in pixels of the input frame. Results are normalized by frame width so they do not
/// depend on the frame size the caller chose.
func motionBetween(_ a: CGImage, _ b: CGImage) throws -> [String: Any] {
	let handler = VNImageRequestHandler(cgImage: a, options: [:])

	let flowReq = VNGenerateOpticalFlowRequest(targetedCGImage: b, options: [:])
	flowReq.computationAccuracy = .medium
	flowReq.outputPixelFormat = kCVPixelFormatType_TwoComponent32Float
	try handler.perform([flowReq])

	guard let flowObs = flowReq.results?.first else { fail("no optical flow result") }
	let buf = flowObs.pixelBuffer
	CVPixelBufferLockBaseAddress(buf, .readOnly)
	defer { CVPixelBufferUnlockBaseAddress(buf, .readOnly) }
	let w = CVPixelBufferGetWidth(buf)
	let h = CVPixelBufferGetHeight(buf)
	let rowBytes = CVPixelBufferGetBytesPerRow(buf)
	guard let base = CVPixelBufferGetBaseAddress(buf) else { fail("empty flow buffer") }

	var xs = [Float]()
	var ys = [Float]()
	xs.reserveCapacity(w * h)
	ys.reserveCapacity(w * h)
	for y in 0..<h {
		let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: Float.self)
		for x in 0..<w {
			xs.append(row[2 * x])
			ys.append(row[2 * x + 1])
		}
	}
	let scale = Float(w)
	let threshold = max(1.0, 0.004 * scale)
	// Camera motion is a robust affine fit of the flow: u = a0 + a1*x + a2*y, v = b0 + b1*x + b2*y, with x and y
	// measured from the frame center in frame widths. It covers shift, zoom, and roll together. Points the fit
	// cannot explain are dropped and the fit repeated, so a subject does not pull the camera estimate. Whatever
	// still disagrees with the final fit is subject motion. A median shift plus a radial zoom was tried first and
	// read handheld roll as subject motion over most of the frame.
	let cx = Float(w) / 2, cy = Float(h) / 2
	var gx = [Double](), gy = [Double](), gu = [Double](), gv = [Double]()
	for y in stride(from: 0, to: h, by: 4) {
		for x in stride(from: 0, to: w, by: 4) {
			let i = y * w + x
			gx.append(Double((Float(x) - cx) / scale))
			gy.append(Double((Float(y) - cy) / scale))
			gu.append(Double(xs[i]))
			gv.append(Double(ys[i]))
		}
	}
	var inlier = [Bool](repeating: true, count: gx.count)
	var pu = [0.0, 0.0, 0.0], pv = [0.0, 0.0, 0.0]
	var cut = Double(threshold)
	for _ in 0..<4 {
		var m = [[Double]](repeating: [0, 0, 0], count: 3)
		var bu = [0.0, 0.0, 0.0], bv = [0.0, 0.0, 0.0]
		for k in 0..<gx.count where inlier[k] {
			let f = [1.0, gx[k], gy[k]]
			for r in 0..<3 {
				for c in 0..<3 { m[r][c] += f[r] * f[c] }
				bu[r] += f[r] * gu[k]
				bv[r] += f[r] * gv[k]
			}
		}
		guard let su = solve3(m, bu), let sv = solve3(m, bv) else { break }
		pu = su
		pv = sv
		var res = [Double]()
		res.reserveCapacity(gx.count)
		for k in 0..<gx.count {
			let ru = gu[k] - (pu[0] + pu[1] * gx[k] + pu[2] * gy[k])
			let rv = gv[k] - (pv[0] + pv[1] * gx[k] + pv[2] * gy[k])
			res.append((ru * ru + rv * rv).squareRoot())
		}
		let med = res.sorted()[res.count / 2]
		// The cut adapts to the frame's own flow noise (blur, rain, compression), so noise is not called motion.
		cut = max(Double(threshold), 2.5 * med)
		for k in 0..<gx.count { inlier[k] = res[k] < cut }
	}
	let inlierFraction = Double(inlier.filter { $0 }.count) / Double(max(gx.count, 1))
	// Shift is in pixels. Zoom and roll are per frame pair: divergence and curl of the fitted field, in pixels
	// per frame width, so dividing by the width gives a fraction.
	let shiftX = Float(pu[0]), shiftY = Float(pv[0])
	let zoomRate = Float((pu[1] + pv[2]) / 2) / scale
	let rollRate = Float((pv[1] - pu[2]) / 2) / scale
	let camMoving = (shiftX * shiftX + shiftY * shiftY).squareRoot() > threshold
	// A zoom of 0.5% per frame pair moves the frame edge by about one pixel at 320 px.
	let zoom: Float = abs(zoomRate) >= 0.005 ? zoomRate : 0
	let roll: Float = abs(rollRate) >= 0.005 ? rollRate : 0
	func model(_ x: Int, _ y: Int) -> (Float, Float) {
		let ox = Double((Float(x) - cx) / scale), oy = Double((Float(y) - cy) / scale)
		return (Float(pu[0] + pu[1] * ox + pu[2] * oy), Float(pv[0] + pv[1] * ox + pv[2] * oy))
	}
	var moving = 0
	var sumX = 0.0, sumY = 0.0, sumDX = 0.0, sumDY = 0.0, sumMag = 0.0
	var minX = w, minY = h, maxX = 0, maxY = 0
	for y in 0..<h {
		for x in 0..<w {
			let i = y * w + x
			let (mx, my) = model(x, y)
			let rx = xs[i] - mx
			let ry = ys[i] - my
			let mag = (rx * rx + ry * ry).squareRoot()
			if Double(mag) >= cut {
				moving += 1
				sumX += Double(x)
				sumY += Double(y)
				sumDX += Double(rx)
				sumDY += Double(ry)
				sumMag += Double(mag)
				minX = min(minX, x)
				minY = min(minY, y)
				maxX = max(maxX, x)
				maxY = max(maxY, y)
			}
		}
	}

	var out: [String: Any] = [
		"content_dx": round3(Double(camMoving ? shiftX / scale : 0)),
		"content_dy": round3(Double(camMoving ? shiftY / scale : 0)),
		"content_zoom": round3(Double(zoom)),
		"content_roll": round3(Double(roll)),
		"background_fraction": round3(inlierFraction),
		"moving_fraction": round3(Double(moving) / Double(w * h)),
	]
	if moving > 0 {
		let n = Double(moving)
		out["subject_x"] = round3(sumX / n / Double(w))
		out["subject_y"] = round3(sumY / n / Double(h))
		out["subject_dx"] = round3(sumDX / n / Double(scale))
		out["subject_dy"] = round3(sumDY / n / Double(scale))
		out["subject_speed"] = round3(sumMag / n / Double(scale))
		out["subject_box"] = [
			round3(Double(minX) / Double(w)), round3(Double(minY) / Double(h)),
			round3(Double(maxX) / Double(w)), round3(Double(maxY) / Double(h)),
		]
	}
	return out
}

/// Pairs run as two contiguous runs at once, so one run's CPU fit overlaps the other's flow request. More runs
/// in one process gave no further gain, so motion.ts also splits long lists across processes.
let motionJobs = 2

func runMotion(_ paths: [String]) {
	guard paths.count >= 2 else { fail("motion needs at least two frames") }
	let pairs = paths.count - 1
	let jobs = min(motionJobs, pairs)
	var results = [[String: Any]?](repeating: nil, count: pairs)
	let lock = NSLock()
	DispatchQueue.concurrentPerform(iterations: jobs) { k in
		// Each run walks its own pairs in order and reuses the loaded frame as the next pair's first frame.
		let first = k * pairs / jobs, last = (k + 1) * pairs / jobs
		var prev = loadImage(paths[first])
		for i in (first + 1)...last {
			let next = loadImage(paths[i])
			do {
				var r = try motionBetween(prev, next)
				r["from"] = i - 1
				r["to"] = i
				lock.lock()
				results[i - 1] = r
				lock.unlock()
			} catch {
				fail("motion failed between \(paths[i - 1]) and \(paths[i]): \(error)")
			}
			prev = next
		}
	}
	emit(results.map { r -> [String: Any] in
		guard let r else { fail("motion result missing") }
		return r
	})
}

// MARK: pose

let poseJoints: [(VNHumanBodyPoseObservation.JointName, String)] = [
	(.nose, "nose"), (.neck, "neck"),
	(.leftShoulder, "left_shoulder"), (.rightShoulder, "right_shoulder"),
	(.leftElbow, "left_elbow"), (.rightElbow, "right_elbow"),
	(.leftWrist, "left_wrist"), (.rightWrist, "right_wrist"),
	(.leftHip, "left_hip"), (.rightHip, "right_hip"),
	(.leftKnee, "left_knee"), (.rightKnee, "right_knee"),
	(.leftAnkle, "left_ankle"), (.rightAnkle, "right_ankle"),
]

/// Vision box in a top-left-origin [x, y, w, h], matching the other modes.
func topLeftBox(_ r: CGRect) -> [Double] {
	[round3(Double(r.minX)), round3(1 - Double(r.maxY)), round3(Double(r.width)), round3(Double(r.height))]
}

func runPose(_ paths: [String]) {
	var results = [[String: Any]]()
	for path in paths {
		// Body pose alone gave false people on a rainy street and missed close selfies (video eval, 2026-10-22).
		// Human rectangles and faces decide who is there. Skeletons only add posture.
		let req = VNDetectHumanBodyPoseRequest()
		let humanReq = VNDetectHumanRectanglesRequest()
		humanReq.upperBodyOnly = false
		let faceReq = VNDetectFaceRectanglesRequest()
		do {
			try VNImageRequestHandler(cgImage: loadImage(path), options: [:]).perform([req, humanReq, faceReq])
		} catch {
			fail("pose failed on \(path): \(error)")
		}
		var people = [[String: Any]]()
		for obs in req.results ?? [] {
			var joints = [String: [Double]]()
			for (name, key) in poseJoints {
				// Vision uses a bottom-left origin. Flip y so 0 is the top of the image, like the other modes.
				if let p = try? obs.recognizedPoint(name), p.confidence > 0.3 {
					joints[key] = [round3(Double(p.location.x)), round3(1 - Double(p.location.y))]
				}
			}
			if !joints.isEmpty { people.append(["confidence": round3(Double(obs.confidence)), "joints": joints]) }
		}
		let humans: [[String: Any]] = (humanReq.results ?? []).map {
			["confidence": round3(Double($0.confidence)), "box": topLeftBox($0.boundingBox)]
		}
		let faces: [[String: Any]] = (faceReq.results ?? []).map {
			["confidence": round3(Double($0.confidence)), "box": topLeftBox($0.boundingBox)]
		}
		results.append(["path": path, "people": people, "humans": humans, "faces": faces])
	}
	emit(results)
}

// MARK: ocr

func runOCR(_ paths: [String]) {
	var results = [[String: Any]]()
	for path in paths {
		let req = VNRecognizeTextRequest()
		req.recognitionLevel = .accurate
		req.usesLanguageCorrection = true
		req.automaticallyDetectsLanguage = true
		do {
			try VNImageRequestHandler(cgImage: loadImage(path), options: [:]).perform([req])
		} catch {
			fail("ocr failed on \(path): \(error)")
		}
		let lines: [[String: Any]] = (req.results ?? []).compactMap { obs in
			guard let top = obs.topCandidates(1).first, top.confidence >= 0.4 else { return nil }
			return ["text": top.string, "confidence": round3(Double(top.confidence))]
		}
		results.append(["path": path, "lines": lines])
	}
	emit(results)
}

// MARK: sounds

final class SoundCollector: NSObject, SNResultsObserving {
	var windows = [[String: Any]]()
	var failure: Error?

	func request(_ request: SNRequest, didProduce result: SNResult) {
		guard let r = result as? SNClassificationResult else { return }
		let labels: [[String: Any]] = r.classifications.prefix(3).compactMap { c in
			c.confidence >= 0.3 ? ["label": c.identifier, "confidence": round3(c.confidence)] : nil
		}
		if labels.isEmpty { return }
		windows.append([
			"start": round3(r.timeRange.start.seconds),
			"end": round3(r.timeRange.end.seconds),
			"labels": labels,
		])
	}

	func request(_ request: SNRequest, didFailWithError error: Error) { failure = error }
}

func runSounds(_ path: String) {
	do {
		let analyzer = try SNAudioFileAnalyzer(url: URL(fileURLWithPath: path))
		let req = try SNClassifySoundRequest(classifierIdentifier: .version1)
		req.windowDuration = CMTime(seconds: 1.0, preferredTimescale: 1000)
		req.overlapFactor = 0.5
		let collector = SoundCollector()
		try analyzer.add(req, withObserver: collector)
		analyzer.analyze()
		if let err = collector.failure { fail("sound analysis failed: \(err)") }
		emit(collector.windows)
	} catch {
		fail("sound analysis failed on \(path): \(error)")
	}
}

// MARK: main

let args = Array(CommandLine.arguments.dropFirst())
guard let mode = args.first else { fail("usage: av-helper motion|pose|ocr|sounds <files...>") }
let files = Array(args.dropFirst())
if files.isEmpty { fail("\(mode) needs at least one file") }
switch mode {
case "motion": runMotion(files)
case "pose": runPose(files)
case "ocr": runOCR(files)
case "sounds": runSounds(files[0])
default: fail("unknown mode \(mode)")
}
