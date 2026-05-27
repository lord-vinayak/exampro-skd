// Copyright (c) 2024, Labeeb Mattra and contributors
// For license information, please see license.txt

// frappe.ui.form.on("Exam Settings", {
// 	refresh(frm) {

// 	},
// });
frappe.ui.form.on("Exam Settings", {
    refresh(frm) {
        frm.add_custom_button(__('Configure S3 CORS'), function() {
            frappe.confirm(
                __('This will apply a CORS policy to your S3/R2 bucket allowing audio and video files to be played in the browser. Proceed?'),
                function() {
                    frappe.call({
                        method: 'exampro.exam_pro.doctype.exam_settings.exam_settings.configure_s3_cors',
                        freeze: true,
                        freeze_message: __('Configuring S3 CORS...'),
                        callback: function(r) {
                            if (r.message && r.message.success) {
                                frappe.msgprint({
                                    title: __('Success'),
                                    message: r.message.message,
                                    indicator: 'green',
                                });
                            }
                        },
                    });
                }
            );
        }, __('Storage'));
    },
    
    validate(frm) {
        const domains = frm.doc.restrict_user_account_domains;
        
        // Skip validation if the field is empty
        if (!domains || domains.trim() === '') return;
        
        const domainArray = domains.split(',').map(domain => domain.trim());
        
        // Check each domain format
        const invalidDomains = domainArray.filter(domain => {
            // Domain should not contain @ and should have at least one dot
            return domain.includes('@') || !domain.includes('.') || /\s/.test(domain);
        });
        
        if (invalidDomains.length > 0) {
            frappe.validated = false;
            frappe.msgprint(
                __(`Invalid domain format: ${invalidDomains.join(', ')}. 
                   Please enter domains without @ symbol (e.g. 'company.com, gmail.com').`)
            );
        }
    }
});