# exampro/www/mobile-proctor.py
import frappe

no_cache = 1

def get_context(context):
    token = frappe.form_dict.get("token", "")
    context.token = token
    context.no_breadcrumbs = True
    context.title = "Mobile Camera - ExamPro"
