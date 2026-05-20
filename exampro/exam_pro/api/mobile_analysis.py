# exampro/exam_pro/api/mobile_analysis.py
"""
Post-exam batch object detection for mobile camera frames.

Flow:
  1. When an Exam Submission status → "Submitted" (and exam has mobile proctoring),
     `enqueue_mobile_analysis()` is called from exam_submission.py.
  2. A background RQ job `run_mobile_analysis(submission_name)` is enqueued on the
     "mobile_analysis" queue.
  3. The job downloads every stored frame from S3 prefix
     `{submission}/mobile_frames/`, runs YOLOv8n on each frame (batched inference),
     creates Exam Messages records for violations, deletes clean frames, then
     marks the submission analysis as Complete.

Detection targets (COCO classes):
  - person count > 1  → mobile_second_person
  - cell phone        → mobile_phone_detected
  - book              → mobile_notes_detected
  - person count == 0 → clean frame (not flagged)
"""

import io
import frappe
from frappe import _

MAX_RETRIES = 5
BATCH_SIZE = 16   # frames per YOLOv8 inference call

# COCO class names we care about (lowercased)
_VIOLATION_CLASSES = {"cell phone", "book"}
_PERSON_CLASS = "person"

# Human-readable labels for the report
_VIOLATION_LABELS = {
    "mobile_second_person":  "Mobile: Second person detected",
    "mobile_phone_detected": "Mobile: Phone/device detected",
    "mobile_notes_detected": "Mobile: Notes/book detected",
}

# ---------------------------------------------------------------------------
# Model cache — one model instance per worker process
# ---------------------------------------------------------------------------

_YOLO_MODEL = None


def _get_yolo_model():
    global _YOLO_MODEL
    if _YOLO_MODEL is not None:
        return _YOLO_MODEL

    try:
        from ultralytics import YOLO
        _YOLO_MODEL = YOLO("yolov8n.pt")   # auto-downloads on first use (~6 MB)
        return _YOLO_MODEL
    except ImportError:
        frappe.log_error(
            "ultralytics package is not installed.\n"
            "Install it with: pip install ultralytics",
            "Mobile Analysis: Missing dependency",
        )
        raise


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

@frappe.whitelist()
def trigger_mobile_analysis(exam_submission):
    """
    Manual trigger — callable from the Exam Submission form button.
    Resets status to Queued and enqueues the job regardless of current status.
    """
    if not frappe.has_permission("Exam Submission", "write", exam_submission):
        frappe.throw(_("Permission denied."), frappe.PermissionError)

    # Check mobile proctoring is enabled for this submission's exam
    exam = frappe.db.get_value("Exam Submission", exam_submission, "exam")
    if not frappe.db.get_value("Exam", exam, "enable_mobile_proctoring"):
        frappe.throw(_("Mobile proctoring is not enabled for this exam."))

    frappe.db.set_value(
        "Exam Submission",
        exam_submission,
        {
            "mobile_analysis_status": "Queued",
            "mobile_analysis_retries": 0,
        },
        update_modified=False,
    )
    frappe.db.commit()

    _enqueue_job(exam_submission)
    return {"status": "queued"}


def enqueue_mobile_analysis(exam_submission):
    """
    Called automatically from exam_submission.py when status → Submitted.
    Only enqueues if the exam has mobile proctoring enabled.
    """
    exam = frappe.db.get_value("Exam Submission", exam_submission, "exam")
    if not frappe.db.get_value("Exam", exam, "enable_mobile_proctoring"):
        return  # nothing to do

    current_status = frappe.db.get_value(
        "Exam Submission", exam_submission, "mobile_analysis_status"
    )
    if current_status in ("Queued", "Processing", "Complete"):
        return  # already running or done

    frappe.db.set_value(
        "Exam Submission",
        exam_submission,
        "mobile_analysis_status",
        "Queued",
        update_modified=False,
    )
    frappe.db.commit()
    _enqueue_job(exam_submission)


def _enqueue_job(exam_submission):
    frappe.enqueue(
        "exampro.exam_pro.api.mobile_analysis.run_mobile_analysis",
        exam_submission=exam_submission,
        queue="long",
        timeout=7200,   # 2 hours max per job
        job_name=f"mobile_analysis:{exam_submission}",
        now=False,
    )


# ---------------------------------------------------------------------------
# Background job — runs in a Frappe RQ worker
# ---------------------------------------------------------------------------

def run_mobile_analysis(exam_submission):
    """
    Main detection job. Downloads frames, runs YOLOv8n, saves violations,
    deletes clean frames, updates status.
    """
    frappe.log_error(
        f"Starting mobile analysis for {exam_submission}",
        "Mobile Analysis",
    )

    # Guard: check retries
    retries = frappe.db.get_value(
        "Exam Submission", exam_submission, "mobile_analysis_retries"
    ) or 0

    if retries >= MAX_RETRIES:
        frappe.db.set_value(
            "Exam Submission",
            exam_submission,
            "mobile_analysis_status",
            "Failed",
            update_modified=False,
        )
        frappe.db.commit()
        frappe.log_error(
            f"Max retries ({MAX_RETRIES}) reached for {exam_submission}",
            "Mobile Analysis: Max Retries",
        )
        return

    # Mark Processing
    frappe.db.set_value(
        "Exam Submission",
        exam_submission,
        "mobile_analysis_status",
        "Processing",
        update_modified=False,
    )
    frappe.db.commit()

    try:
        _run_analysis(exam_submission)
    except Exception:
        frappe.log_error(frappe.get_traceback(), f"Mobile Analysis Failed: {exam_submission}")
        # Increment retries and re-queue
        new_retries = retries + 1
        frappe.db.set_value(
            "Exam Submission",
            exam_submission,
            {
                "mobile_analysis_status": "Failed" if new_retries >= MAX_RETRIES else "Queued",
                "mobile_analysis_retries": new_retries,
            },
            update_modified=False,
        )
        frappe.db.commit()

        if new_retries < MAX_RETRIES:
            _enqueue_job(exam_submission)


def _run_analysis(exam_submission):
    """Core analysis logic — called inside run_mobile_analysis."""
    from exampro.exam_pro.doctype.exam_submission.exam_submission import get_s3_client

    settings = frappe.get_single("Exam Settings")
    s3_client = get_s3_client()
    bucket = settings.s3_bucket
    prefix = f"{exam_submission}/mobile_frames/"

    # 1. List all frames stored during the exam
    frame_keys = _list_s3_keys(s3_client, bucket, prefix)
    frame_keys.sort()  # chronological order

    frappe.log_error(
        f"{exam_submission}: found {len(frame_keys)} frames to analyse",
        "Mobile Analysis",
    )

    if not frame_keys:
        # No frames — mark complete with zero counts
        frappe.db.set_value(
            "Exam Submission",
            exam_submission,
            {
                "mobile_analysis_status": "Complete",
                "mobile_frame_count": 0,
                "mobile_violation_count": 0,
            },
            update_modified=False,
        )
        frappe.db.commit()
        return

    # 2. Load model (cached per worker)
    model = _get_yolo_model()

    candidate = frappe.db.get_value("Exam Submission", exam_submission, "candidate")
    violation_count = 0
    keys_to_delete = []

    # 3. Process in batches of BATCH_SIZE
    for batch_start in range(0, len(frame_keys), BATCH_SIZE):
        batch_keys = frame_keys[batch_start: batch_start + BATCH_SIZE]
        batch_images = []
        batch_valid_keys = []

        for key in batch_keys:
            try:
                obj = s3_client.get_object(Bucket=bucket, Key=key)
                img_bytes = obj["Body"].read()
                batch_images.append(img_bytes)
                batch_valid_keys.append(key)
            except Exception as e:
                frappe.log_error(
                    f"Failed to download frame {key}: {e}", "Mobile Analysis"
                )

        if not batch_images:
            continue

        # Run batched inference
        try:
            import numpy as np
            import cv2

            np_images = []
            for img_bytes in batch_images:
                arr = np.frombuffer(img_bytes, np.uint8)
                img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                if img is not None:
                    np_images.append(img)
                else:
                    np_images.append(None)

            # Filter out None (undecodable) images
            valid_pairs = [(img, key) for img, key in zip(np_images, batch_valid_keys) if img is not None]
            if not valid_pairs:
                continue

            valid_images, valid_keys = zip(*valid_pairs)
            results = model(list(valid_images), verbose=False)

        except Exception as e:
            frappe.log_error(
                f"YOLOv8 inference failed on batch starting at {batch_start}: {e}",
                "Mobile Analysis",
            )
            continue

        # 4. Process each result
        for result, key in zip(results, valid_keys):
            violation = _classify_result(result, model.names)
            if violation:
                # Keep the frame — store S3 key and create Exam Messages record
                try:
                    frappe.db.begin()
                    _save_violation(
                        exam_submission=exam_submission,
                        candidate=candidate,
                        violation_type=violation,
                        s3_key=key,
                    )
                    frappe.db.commit()
                    violation_count += 1
                except Exception:
                    frappe.log_error(
                        frappe.get_traceback(),
                        f"Mobile Analysis: Save violation skipped ({key})",
                    )
                    try:
                        frappe.db.rollback()
                    except Exception:
                        pass
            else:
                # Mark for deletion to save storage
                keys_to_delete.append(key)

    # 5. Batch-delete clean frames
    if keys_to_delete:
        _batch_delete_s3(s3_client, bucket, keys_to_delete)

    # 6. Mark Complete
    frappe.db.set_value(
        "Exam Submission",
        exam_submission,
        {
            "mobile_analysis_status": "Complete",
            "mobile_frame_count": len(frame_keys),
            "mobile_violation_count": violation_count,
        },
        update_modified=False,
    )
    frappe.db.commit()

    frappe.log_error(
        f"{exam_submission}: analysis complete. "
        f"Frames={len(frame_keys)}, violations={violation_count}, deleted={len(keys_to_delete)}",
        "Mobile Analysis",
    )


# ---------------------------------------------------------------------------
# Detection helpers
# ---------------------------------------------------------------------------

def _classify_result(result, names):
    """
    Given a single YOLOv8 result, return a violation type string or None.
    Priority: second_person > phone > notes > no_person

    Confidence thresholds prevent false positives:
    - PERSON_CONF: 0.55  — reduces duplicate head+body detections of same person
    - OBJ_CONF:    0.45  — reasonable threshold for phone/book detection
    Both thresholds are deliberately higher than YOLO's default (0.25).
    """
    PERSON_CONF = 0.55
    OBJ_CONF    = 0.45

    if result.boxes is None or len(result.boxes) == 0:
        return None   # no detections — treat as clean frame

    boxes = result.boxes
    person_count = 0
    detected_objects = []

    for i, cls in enumerate(boxes.cls):
        class_name = names[int(cls)].lower()
        conf = float(boxes.conf[i])

        if class_name == _PERSON_CLASS:
            if conf >= PERSON_CONF:
                person_count += 1
        elif class_name in _VIOLATION_CLASSES:
            if conf >= OBJ_CONF:
                detected_objects.append(class_name)

    if person_count == 0:
        return None   # no face visible — not flagged
    if person_count > 1:
        return "mobile_second_person"

    if "cell phone" in detected_objects:
        return "mobile_phone_detected"
    if "book" in detected_objects:
        return "mobile_notes_detected"

    return None   # clean frame


def _save_violation(exam_submission, candidate, violation_type, s3_key):
    """Insert an Exam Messages record for a detected post-exam violation."""
    # Idempotency: don't insert a duplicate if this job was retried
    if frappe.db.exists(
        "Exam Messages",
        {"exam_submission": exam_submission, "mobile_snapshot_key": s3_key},
    ):
        return  # already recorded — skip silently

    label = _VIOLATION_LABELS.get(violation_type, violation_type)
    try:
        frappe.get_doc({
            "doctype": "Exam Messages",
            "exam_submission": exam_submission,
            "timestamp": frappe.utils.now(),
            "from": "System",
            "from_user": candidate,
            "message": label,
            "type_of_message": "Warning",
            "warning_type": violation_type,
            "mobile_snapshot_key": s3_key,
        }).insert(ignore_permissions=True)
    except Exception as e:
        frappe.log_error(
            f"Failed to save violation record for {exam_submission}, key={s3_key}: {e}",
            "Mobile Analysis",
        )


# ---------------------------------------------------------------------------
# S3 helpers
# ---------------------------------------------------------------------------

def _list_s3_keys(s3_client, bucket, prefix):
    keys = []
    paginator = s3_client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            if obj["Key"].lower().endswith(".jpg"):
                keys.append(obj["Key"])
    return keys


def _batch_delete_s3(s3_client, bucket, keys):
    """Delete keys in batches of 1000 (S3 API limit per call)."""
    for i in range(0, len(keys), 1000):
        batch = [{"Key": k} for k in keys[i: i + 1000]]
        try:
            s3_client.delete_objects(Bucket=bucket, Delete={"Objects": batch})
        except Exception as e:
            frappe.log_error(
                f"S3 batch delete failed: {e}", "Mobile Analysis"
            )


# ---------------------------------------------------------------------------
# API for submission list / report
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_mobile_analysis_results(exam_submission):
    """
    Return all mobile violation records for the auxiliary camera report.
    Used by proctoring_report.py and the submission form Mobile tab.
    """
    messages = frappe.get_all(
        "Exam Messages",
        filters={
            "exam_submission": exam_submission,
            "warning_type": ["in", [
                "mobile_second_person",
                "mobile_phone_detected",
                "mobile_notes_detected",
                "mobile_multiplefaces",
                "mobile_disconnect",
                "mobile_device_detected",
            ]],
        },
        fields=["name", "warning_type", "message", "timestamp", "mobile_snapshot_key"],
        order_by="timestamp asc",
    )

    from exampro.exam_pro.doctype.exam_submission.exam_submission import get_s3_client
    settings = frappe.get_single("Exam Settings")
    s3_client = get_s3_client()

    for msg in messages:
        if msg.get("mobile_snapshot_key"):
            try:
                msg["snapshot_url"] = s3_client.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": settings.s3_bucket, "Key": msg.mobile_snapshot_key},
                    ExpiresIn=3600,
                )
            except Exception:
                msg["snapshot_url"] = None
        else:
            msg["snapshot_url"] = None

    return messages
