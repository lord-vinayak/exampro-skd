# exampro/www/mobile-proctor.py
import frappe

no_cache = 1

def get_context(context):
    token = frappe.form_dict.get("token", "")
    context.token = token
    context.no_breadcrumbs = True
    context.title = "Mobile Camera - ExamPro"

    # Check if this exam requires a room scan
    context.require_room_scan = False
    if token:
        try:
            result = frappe.db.get_value(
                "Exam Submission",
                {"mobile_session_token": token},
                ["name", "exam", "room_scan_key"],
                as_dict=True,
            )
            if result and result.exam:
                # Only show room scan section if required AND not already uploaded
                requires = frappe.db.get_value("Exam", result.exam, "require_room_scan")
                already_done = bool(result.room_scan_key)
                context.require_room_scan = bool(requires) and not already_done
        except Exception:
            frappe.log_error(frappe.get_traceback(), "Mobile Proctor Context Error")
