// Copyright (c) 2024, Labeeb Mattra and contributors
// For license information, please see license.txt

// frappe.ui.form.on("Exam Submission", {
// 	refresh(frm) {

// 	},
// });

frappe.ui.form.on("Exam Submission", {
    refresh(frm) {
        // Handle video display
        frappe.call({
            method: "exampro.exam_pro.doctype.exam_submission.exam_submission.exam_video_list",
            args: {
                "exam_submission": frm.doc.name,
            },
            callback: function (r) {

                // Convert the object into an array of key-value pairs
                const videoArray = Object.entries(r.message.videos);
                if (videoArray != 0) {
                    $('#videoDiv').removeClass("hidden");
                    // Sort the array based on Unix timestamps in ascending order
                    videoArray.sort((a, b) => a[0] - b[0]);
                    var videoElement = document.getElementById("candidateVideo");
                    var playPauseBtn = document.getElementById('play-pause-btn');
                    var previousBtn = document.getElementById('previous-btn');
                    var nextBtn = document.getElementById('next-btn');
                    var indexField = document.getElementById('index-field');

                    var currentIndex = 0;

                    function playVideo() {
                        videoElement.src = videoArray[currentIndex][1];
                        videoElement.play();
                        indexField.value = (currentIndex + 1) + '/' + videoArray.length;
                    }

                    playPauseBtn.addEventListener('click', function () {
                        if (videoElement.paused) {
                            videoElement.play();
                        } else {
                            videoElement.pause();
                        }
                    });

                    previousBtn.addEventListener('click', function () {
                        currentIndex--;
                        playVideo();
                    });

                    nextBtn.addEventListener('click', function () {
                        currentIndex++;
                        playVideo();
                    });

                    // Initial video playback
                    playVideo();
                }
            },
        });

        // Replace retina_location_log field with canvas plot
        if (frm.doc.retina_location_log) {
            // Hide the original JSON field
            frm.set_df_property('retina_location_log', 'hidden', 1);
            
            // Create canvas element for plotting
            const plotHtml = `
                <div class="form-group">
                    <div class="clearfix">
                        <label class="control-label">Retina Location Plot</label>
                    </div>
                    <div class="control-input-wrapper">
                        <canvas id="plotCanvas" width="300" height="300" style="border: 1px solid #ddd; border-radius: 4px;"></canvas>
                        <div style="margin-top: 10px; display: flex; gap: 20px; font-size: 12px;">
                            <div style="display: flex; align-items: center; gap: 5px;">
                                <div style="width: 12px; height: 12px; border-radius: 50%; background-color: #27ae60;"></div>
                                <span>Screen Gaze</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 5px;">
                                <div style="width: 12px; height: 12px; border-radius: 50%; background-color: #e74c3c;"></div>
                                <span>Away Gaze</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 5px;">
                                <div style="width: 12px; height: 12px; border-radius: 50%; background-color: #f1c40f;"></div>
                                <span>Distracted Gaze</span>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            // Insert the canvas after the retina_location_log field
            $(frm.fields_dict.retina_location_log.wrapper).after(plotHtml);
            
            // Draw the plot
            setTimeout(() => {
                drawRetinaPlot(frm.doc.retina_location_log);
            }, 100);
        }

        // Room scan video viewer
        if (frm.doc.room_scan_key) {
            frappe.call({
                method: 'exampro.exam_pro.doctype.exam_submission.exam_submission.get_room_scan_url',
                args: { exam_submission: frm.doc.name },
                callback: function(r) {
                    if (r.message) {
                        $('#roomScanDiv').removeClass('hidden');
                        document.getElementById('roomScanVideo').src = r.message;
                    }
                }
            });
        }

        // Mobile snapshots viewer
        if (frm.doc.mobile_camera_status && frm.doc.mobile_camera_status !== 'Pending') {
            renderMobileSnapshots(frm);
        }

        // Audio recordings section (noise monitoring)
        if (["Submitted", "Terminated"].includes(frm.doc.status)) {
            renderAudioRecordings(frm);
        }

        // Proctoring Report Download Button
        if (["Submitted", "Terminated"].includes(frm.doc.status)) {
            frm.add_custom_button(__('Download Proctoring Report'), function() {
                frappe.call({
                    method: 'exampro.exam_pro.api.proctoring_report.generate_proctoring_report',
                    args: {
                        exam_submission: frm.doc.name
                    },
                    freeze: true,
                    freeze_message: __('Generating proctoring report...'),
                    callback: function(r) {
                        if (r.message) {
                            const link = document.createElement('a');
                            link.href = 'data:application/pdf;base64,' + r.message;
                            link.download = `proctoring_report_${frm.doc.name}.pdf`;
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);
                        }
                    }
                });
            }, __('Actions'));
        }
    },
});

async function renderMobileSnapshots(frm) {
    const result = await frappe.call({
        method: 'exampro.exam_pro.doctype.exam_submission.exam_submission.get_mobile_violation_snapshots',
        args: { exam_submission: frm.doc.name },
    });

    const snapshots = result.message || [];
    if (!snapshots.length) return;

    const html = `
        <div style="margin-top:1rem; padding:1rem; border-top:1px solid #eee;">
            <h6>📱 Mobile Camera Violations (${snapshots.length})</h6>
            <div style="display:flex;flex-wrap:wrap;gap:0.75rem;margin-top:0.5rem;">
                ${snapshots.map(s => `
                    <div style="text-align:center;cursor:pointer;" onclick="window.open('${s.snapshot_url || '#'}','_blank')">
                        ${s.snapshot_url ? `<img src="${s.snapshot_url}" style="width:120px;height:90px;object-fit:cover;border-radius:6px;border:1px solid #ddd;" onerror="this.style.display='none'">` : '<div style="width:120px;height:90px;background:#eee;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:0.7rem;color:#999;">No image</div>'}
                        <div style="font-size:0.7rem;color:#666;margin-top:2px;">
                            ${frappe.datetime.str_to_user(s.timestamp)}<br>
                            <span class="badge bg-warning text-dark" style="font-size:0.65rem;">${s.warning_type}</span>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;

    // Try to append to the form wrapper (below the form fields)
    frm.fields_dict['mobile_camera_status']?.$wrapper
        ?.closest('.frappe-card')
        ?.append(`<div id="mobile-snapshots-section">${html}</div>`);

    // Fallback: append to page main section
    if (!frm.page.main.find('#mobile-snapshots-section').length) {
        // remove old instance if present
        frm.page.main.find('#mobile-snapshots-section').remove();
        frm.page.main.append(`<div id="mobile-snapshots-section">${html}</div>`);
    }
}

async function renderAudioRecordings(frm) {
    const result = await frappe.call({
        method: 'exampro.exam_pro.doctype.exam_submission.exam_submission.get_audio_recordings',
        args: { exam_submission: frm.doc.name },
    });

    const recordings = result.message || [];

    // Remove any previously rendered section (on form reload)
    frm.page.main.find('#audio-recordings-section').remove();

    if (!recordings.length) return;

    const rows = recordings.map((rec, idx) => {
        const ts = rec.timestamp
            ? frappe.datetime.str_to_user(rec.timestamp)
            : `Recording ${idx + 1}`;
        const audioEl = rec.audio_url
            ? `<audio controls style="width:100%;max-width:400px;">
                   <source src="${rec.audio_url}" type="audio/webm">
                   Your browser does not support audio playback.
               </audio>`
            : `<span style="color:#999;font-size:0.8rem;">Audio unavailable</span>`;

        return `
            <tr>
                <td style="width:180px;white-space:nowrap;padding:6px 8px;color:#555;font-size:0.85rem;">
                    ${ts}
                </td>
                <td style="padding:6px 8px;font-size:0.85rem;color:#666;">
                    ${rec.message || 'Noise detected'}
                </td>
                <td style="padding:6px 8px;">
                    ${audioEl}
                </td>
            </tr>`;
    }).join('');

    const html = `
        <div id="audio-recordings-section" style="margin:1.5rem 0;padding:1rem;border:1px solid #e0e0e0;border-radius:6px;background:#fafafa;">
            <h6 style="margin-bottom:0.75rem;font-weight:600;">🎙️ Audio Monitoring — Noise Detected (${recordings.length} window${recordings.length !== 1 ? 's' : ''})</h6>
            <p style="font-size:0.8rem;color:#888;margin-bottom:0.75rem;">
                Each row is a 30-second window where ambient noise exceeded the monitoring threshold.
            </p>
            <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:4px;overflow:hidden;border:1px solid #eee;">
                <thead>
                    <tr style="background:#f5f5f5;">
                        <th style="padding:6px 8px;text-align:left;font-size:0.82rem;font-weight:600;color:#444;">Timestamp</th>
                        <th style="padding:6px 8px;text-align:left;font-size:0.82rem;font-weight:600;color:#444;">Description</th>
                        <th style="padding:6px 8px;text-align:left;font-size:0.82rem;font-weight:600;color:#444;">Recording</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        </div>`;

    frm.page.main.append(html);
}

function drawRetinaPlot(retinaData) {
    const canvas = document.getElementById('plotCanvas');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const plotWidth = canvas.width;
    const plotHeight = canvas.height;
    
    // Parse the JSON data
    let data = [];
    try {
        data = JSON.parse(retinaData) || [];
    } catch (e) {
        console.error('Error parsing retina location data:', e);
        return;
    }

    // Clear canvas with simple background
    ctx.fillStyle = '#f8f8f8';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw grid lines for reference (3x3 grid)
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    
    // Vertical grid lines (thirds)
    for (let i = 1; i < 3; i++) {
        const x = (plotWidth / 3) * i;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
    }
    
    // Horizontal grid lines (thirds)
    for (let i = 1; i < 3; i++) {
        const y = (plotHeight / 3) * i;
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
    }
    ctx.stroke();

    // Plot retina tracking points
    data.forEach((point, index) => {
        const canvasX = point.x * plotWidth;
        const canvasY = point.y * plotHeight;
        
        // Set color based on gaze direction - bright colors for visibility
        let color;
        switch(point.gazeDirection) {
            case 'screen':
                color = '#27ae60'; // Green for screen gaze
                break;
            case 'away':
                color = '#e74c3c'; // Red for away gaze
                break;
            case 'distracted':
                color = '#f1c40f'; // Yellow for distracted gaze
                break;
            default:
                color = '#95a5a6'; // Gray for unknown/undefined
        }
        ctx.fillStyle = color;
        
        // Draw bigger point for visibility
        ctx.beginPath();
        ctx.arc(canvasX, canvasY, 12, 0, 2 * Math.PI);
        ctx.fill();
        
        // Add point number with better contrast
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'center';
        ctx.fillText((index + 1).toString(), canvasX, canvasY + 5);
    });
}
