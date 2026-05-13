// setup.js — First-time setup wizard
// Runs when no admin PIN has been configured yet.
// Redirects to index.html if setup is already complete.

async function sha256(str) {
    const buffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

document.addEventListener('DOMContentLoaded', async function () {
    // If already set up, skip to the main page
    try {
        const existsResp = await fetch('/api/pin/exists');
        const { exists } = await existsResp.json();
        if (exists) {
            window.location.href = 'index.html';
            return;
        }
    } catch (_) { /* server unreachable — show setup anyway */ }

    const step1     = document.getElementById('step1');
    const step2     = document.getElementById('step2');
    const stepDone  = document.getElementById('stepDone');

    const pinInput   = document.getElementById('pinInput');
    const pinConfirm = document.getElementById('pinConfirm');
    const pinError   = document.getElementById('pinError');
    const pinNextBtn = document.getElementById('pinNextBtn');

    const calendarInput = document.getElementById('calendarInput');
    const calendarError = document.getElementById('calendarError');
    const calSkipBtn    = document.getElementById('calSkipBtn');
    const calSaveBtn    = document.getElementById('calSaveBtn');

    // ---- Step 1: PIN ----

    function showPinError(msg) {
        pinError.textContent = msg;
        pinError.style.display = 'block';
    }

    pinNextBtn.addEventListener('click', async function () {
        pinError.style.display = 'none';
        const pin     = pinInput.value.trim();
        const confirm = pinConfirm.value.trim();

        if (!/^\d{4}$/.test(pin)) {
            showPinError('PIN must be exactly 4 digits.');
            return;
        }
        if (pin !== confirm) {
            showPinError('PINs do not match. Try again.');
            pinConfirm.value = '';
            pinConfirm.focus();
            return;
        }

        pinNextBtn.disabled = true;
        try {
            const hash = await sha256(pin);
            const resp = await fetch('/api/pin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hash }),
            });
            if (!resp.ok) {
                const data = await resp.json();
                throw new Error(data.error || 'Failed to save PIN.');
            }
            step1.classList.remove('active');
            step2.classList.add('active');
        } catch (err) {
            showPinError(err.message);
            pinNextBtn.disabled = false;
        }
    });

    // Allow Enter key to advance
    [pinInput, pinConfirm].forEach(el => {
        el.addEventListener('keydown', e => { if (e.key === 'Enter') pinNextBtn.click(); });
    });

    // ---- Step 2: Calendar URL ----

    async function finishSetup() {
        step2.classList.remove('active');
        stepDone.classList.add('active');
        setTimeout(() => { window.location.href = 'index.html'; }, 1500);
    }

    calSkipBtn.addEventListener('click', finishSetup);

    calSaveBtn.addEventListener('click', async function () {
        calendarError.style.display = 'none';
        const url = calendarInput.value.trim();

        if (!url) {
            await finishSetup();
            return;
        }
        if (!url.startsWith('https://calendar.google.com/')) {
            calendarError.textContent = 'Must be a Google Calendar embed URL (https://calendar.google.com/…)';
            calendarError.style.display = 'block';
            return;
        }

        calSaveBtn.disabled = true;
        calSkipBtn.disabled = true;
        try {
            const resp = await fetch('/api/calendar-url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url }),
            });
            if (!resp.ok) {
                const data = await resp.json();
                throw new Error(data.error || 'Failed to save calendar URL.');
            }
            await finishSetup();
        } catch (err) {
            calendarError.textContent = err.message;
            calendarError.style.display = 'block';
            calSaveBtn.disabled = false;
            calSkipBtn.disabled = false;
        }
    });

    calendarInput.addEventListener('keydown', e => { if (e.key === 'Enter') calSaveBtn.click(); });
});
