"""
Run with: bench --site exampro.local execute debug_mobile.check
"""
import frappe

def check():
    # 1. Check mobile violation messages in DB
    msgs = frappe.db.sql("""
        SELECT name, warning_type, mobile_snapshot_key, creation
        FROM `tabExam Messages`
        WHERE warning_type LIKE 'mobile%'
        ORDER BY creation DESC
        LIMIT 10
    """, as_dict=True)

    print(f"\n=== Mobile Violation Messages ({len(msgs)} found) ===")
    for m in msgs:
        print(f"  {m.creation} | {m.warning_type} | key={m.mobile_snapshot_key}")

    # 2. Check if mobile_snapshot_key column exists
    cols = frappe.db.sql("""
        SHOW COLUMNS FROM `tabExam Messages` LIKE 'mobile_snapshot_key'
    """)
    print(f"\n=== mobile_snapshot_key column exists: {bool(cols)} ===")

    # 3. Check Exam Submission fields
    sub_cols = frappe.db.sql("""
        SHOW COLUMNS FROM `tabExam Submission`
        WHERE Field IN ('mobile_session_token','mobile_camera_status','mobile_last_seen')
    """)
    print(f"\n=== Exam Submission mobile columns: {[c[0] for c in sub_cols]} ===")

    # 4. Check recent exam submissions with mobile data
    subs = frappe.db.sql("""
        SELECT name, status, mobile_camera_status, mobile_last_seen,
               LEFT(mobile_session_token,8) as token_prefix
        FROM `tabExam Submission`
        WHERE mobile_camera_status IS NOT NULL
        ORDER BY modified DESC LIMIT 5
    """, as_dict=True)
    print(f"\n=== Recent Submissions with Mobile Data ===")
    for s in subs:
        print(f"  {s.name} | {s.status} | cam={s.mobile_camera_status} | last_seen={s.mobile_last_seen} | token={s.token_prefix}...")

    # 5. Test mediapipe import
    print("\n=== MediaPipe Test ===")
    try:
        import cv2, mediapipe as mp, numpy as np
        print(f"  cv2={cv2.__version__}, mediapipe={mp.__version__}")
        # Create a tiny black image and run face detection
        img = np.zeros((100, 100, 3), dtype=np.uint8)
        det = mp.solutions.face_detection.FaceDetection(model_selection=0)
        res = det.process(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        print(f"  Face detection on black image: {res.detections} (expected None/empty = OK)")
    except Exception as e:
        print(f"  ERROR: {e}")

    # 6. Check S3 config
    print("\n=== S3 Config ===")
    try:
        settings = frappe.get_single("Exam Settings")
        print(f"  bucket={settings.s3_bucket}")
        print(f"  endpoint={getattr(settings, 's3_endpoint_url', 'not set')}")
        print(f"  region={getattr(settings, 's3_region', 'not set')}")
        has_key = bool(getattr(settings, 's3_access_key', None))
        print(f"  has_access_key={has_key}")
    except Exception as e:
        print(f"  ERROR reading Exam Settings: {e}")
