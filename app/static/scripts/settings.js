const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("saveBtn");

function setStatusOk(msg) {
    statusEl.textContent = msg;
    statusEl.className = "status ok";
}
function setStatusErr(msg) {
    statusEl.textContent = msg;
    statusEl.className = "status err";
}

async function loadSettings() {
    try {
        const res = await fetch("/api/settings");
        if (!res.ok) throw new Error("Failed to load settings");
        const settings = await res.json();

        const t = settings.time || {};
        document.getElementById("time_timezone").value = t.timezone ?? "Europe/Copenhagen";

        const al = settings.alarm_listener || {};
        document.getElementById("log_raw_payload").checked = !!al.log_raw_payload;
        document.getElementById("listen_host").value = al.listen_host ?? "0.0.0.0";
        document.getElementById("listen_port").value = al.listen_port ?? 15000;

        const uc = settings.upload_cleanup || {};
        document.getElementById("upload_cleanup_enabled").checked = uc.enabled ?? true;
        document.getElementById("upload_max_total_mb").value = uc.max_total_mb ?? 4096;
        document.getElementById("upload_min_file_age_seconds").value = uc.min_file_age_seconds ?? 60;
        document.getElementById("upload_interval_seconds").value = uc.interval_seconds ?? 60;
        document.getElementById("upload_delete_empty_dirs").checked = uc.delete_empty_dirs ?? true;

        setStatusOk("Settings loaded.");
    } catch (e) {
        setStatusErr("Error: " + e.message);
    }
}

async function saveSettings() {
    saveBtn.disabled = true;
    try {
        const payload = {
            time: {
                timezone: document.getElementById("time_timezone").value.trim() || "Europe/Copenhagen"
            },
            alarm_listener: {
                log_raw_payload: document.getElementById("log_raw_payload").checked,
                listen_host: document.getElementById("listen_host").value.trim(),
                listen_port: parseInt(document.getElementById("listen_port").value, 10)
            },
            upload_cleanup: {
                enabled: document.getElementById("upload_cleanup_enabled").checked,
                max_total_mb: parseInt(document.getElementById("upload_max_total_mb").value, 10),
                min_file_age_seconds: parseInt(document.getElementById("upload_min_file_age_seconds").value, 10),
                interval_seconds: parseInt(document.getElementById("upload_interval_seconds").value, 10),
                delete_empty_dirs: document.getElementById("upload_delete_empty_dirs").checked
            }
        };

        const res = await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const txt = await res.text();
            throw new Error("Save failed: " + txt);
        }

        setStatusOk("Saved! Restart container for listener port/host changes to take effect.");
    } catch (e) {
        setStatusErr("Error: " + e.message);
    } finally {
        saveBtn.disabled = false;
    }
}

saveBtn.addEventListener("click", saveSettings);

const restartAlarmBtn = document.getElementById("restartAlarmBtn");

async function restartAlarm() {
    restartAlarmBtn.disabled = true;
    try {
        const res = await fetch("/api/alarm/restart", { method: "POST" });
        if (!res.ok) {
            const txt = await res.text();
            throw new Error("Restart failed: " + txt);
        }
        setStatusOk("Alarm listener restarted.");
    } catch (e) {
        setStatusErr("Error: " + e.message);
    } finally {
        restartAlarmBtn.disabled = false;
    }
}

restartAlarmBtn.addEventListener("click", restartAlarm);

loadSettings();
