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

    const clientIdInput     = document.getElementById('clientIdInput');
    const clientSecretInput = document.getElementById('clientSecretInput');
    const credsError        = document.getElementById('credsError');
    const credsSkipBtn      = document.getElementById('credsSkipBtn');
    const credsSaveBtn      = document.getElementById('credsSaveBtn');

    // PIN hash is stored here after step 1 so step 2 can authenticate its request.
    let pinHash = '';

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
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ hash }),
            });
            if (!resp.ok) {
                const data = await resp.json();
                throw new Error(data.error || 'Failed to save PIN.');
            }
            pinHash = hash;
            step1.classList.remove('active');
            step2.classList.add('active');
        } catch (err) {
            showPinError(err.message);
            pinNextBtn.disabled = false;
        }
    });

    [pinInput, pinConfirm].forEach(el => {
        el.addEventListener('keydown', e => { if (e.key === 'Enter') pinNextBtn.click(); });
    });

    // ---- Step 2: Google credentials ----

    function finishSetup() {
        step2.classList.remove('active');
        stepDone.classList.add('active');
        setTimeout(() => { window.location.href = 'index.html'; }, 1500);
    }

    credsSkipBtn.addEventListener('click', finishSetup);

    credsSaveBtn.addEventListener('click', async function () {
        credsError.style.display = 'none';
        const clientId     = clientIdInput.value.trim();
        const clientSecret = clientSecretInput.value.trim();

        if (!clientId && !clientSecret) {
            finishSetup();
            return;
        }
        if (!clientId || !clientSecret) {
            credsError.textContent = 'Enter both the Client ID and Client Secret, or skip.';
            credsError.style.display = 'block';
            return;
        }

        credsSaveBtn.disabled = true;
        credsSkipBtn.disabled = true;
        try {
            const resp = await fetch('/api/auth/google/credentials', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'X-Admin-Pin-Hash': pinHash },
                body:    JSON.stringify({ clientId, clientSecret }),
            });
            if (!resp.ok) {
                const data = await resp.json();
                throw new Error(data.error || 'Failed to save credentials.');
            }
            finishSetup();
        } catch (err) {
            credsError.textContent = err.message;
            credsError.style.display = 'block';
            credsSaveBtn.disabled = false;
            credsSkipBtn.disabled = false;
        }
    });

    [clientIdInput, clientSecretInput].forEach(el => {
        el.addEventListener('keydown', e => { if (e.key === 'Enter') credsSaveBtn.click(); });
    });
});
