# Spec

## Round 1 (2026-10-22)

| ID | Requirement | Source | Test |
|---|---|---|---|
| R1 | Picked photos land in `$TMPDIR` with correct count and readable files | use_case "download to TMP" | Grader counts files and decodes each one |
| R2 | Only one device is needed. The picker opens on the laptop | user answer 8 | Live smoke: an `open` call is seen and there is no QR or phone step |
| R3 | Time, camera, and type filters work on the picked set | use_case "metadata" | T5 precision and recall by createTime |
| R4 | Follow-up questions reuse the picked set | example_workflows (live notes) | T6 counts any second pick |
| R5 | No files outside `$TMPDIR`, and the session is deleted | use_case "not permanent" | File system diff plus a check that the session is gone |
| R6 | Auth runs on its own when the token is missing or revoked | house rule | T7 completes with no user command |
| R7 | Location is honestly reported as not available, and the model suggests a picker search instead | research r01 | A rubric item in T5 and T8 |
