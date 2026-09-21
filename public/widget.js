/**
 * Sitewright embeddable chat widget — streaming, memory, lead capture, handoff.
 *
 *   <script src="https://your-server.example.com/widget.js"
 *           data-client-id="example"
 *           data-business="Acme Bike Co"
 *           data-color="#2563eb"
 *           data-endpoint="https://your-server.example.com"></script>
 *
 * Runs inside a Shadow DOM so it never collides with the host site's CSS.
 */
(function () {
  var thisScript = document.currentScript;
  var clientId = thisScript.dataset.clientId || 'example';
  var business = thisScript.dataset.business || 'this business';
  var color = thisScript.dataset.color || '#2563eb';
  var endpoint = (thisScript.dataset.endpoint || '').replace(/\/$/, '');
  var sessionId = 'sw_' + Math.random().toString(36).slice(2) + Date.now();

  // 1. memory — kept client-side for this tab session, sent with every request
  var history = [];
  var leadCaptured = false;

  var host = document.createElement('div');
  host.id = 'sw-chat-widget-root';
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
    <style>
      :host{ all: initial; }
      .sw-launcher{
        position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
        width: 58px; height: 58px; border-radius: 50%; border: none; cursor: pointer;
        background: ${color}; color: #fff; box-shadow: 0 6px 20px rgba(0,0,0,0.25);
        display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif;
      }
      .sw-launcher svg{ width: 26px; height: 26px; }
      .sw-panel{
        position: fixed; right: 20px; bottom: 90px; z-index: 2147483000;
        width: min(360px, calc(100vw - 40px)); max-height: min(520px, calc(100vh - 140px));
        background: #fff; border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.22);
        display: none; flex-direction: column; overflow: hidden;
        font-family: system-ui, -apple-system, sans-serif; border: 1px solid rgba(0,0,0,0.08);
      }
      .sw-panel.open{ display: flex; }
      .sw-head{ background: ${color}; color: #fff; padding: 12px 16px; display:flex; justify-content:space-between; align-items:center; gap:10px; }
      .sw-head-text b{ font-size: 14px; display:block; }
      .sw-head-text span{ display:block; font-size: 11px; opacity: 0.85; margin-top: 2px; }
      .sw-human-btn{ background: rgba(255,255,255,0.18); border: 1px solid rgba(255,255,255,0.4); color:#fff; font-size: 11px; padding: 5px 9px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
      .sw-body{ flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; background: #f9f9f7; }
      .sw-msg{ max-width: 85%; padding: 8px 11px; border-radius: 10px; font-size: 13.5px; line-height: 1.4; white-space: pre-wrap; }
      .sw-msg.bot{ background: #fff; border: 1px solid #e1e0d9; align-self: flex-start; color: #0b0b0b; }
      .sw-msg.user{ background: ${color}; color: #fff; align-self: flex-end; }
      .sw-msg.system{ align-self: center; font-size: 11.5px; color: #898781; background: transparent; }
      .sw-foot{ display: flex; gap: 6px; padding: 10px; border-top: 1px solid #e1e0d9; background: #fff; }
      .sw-foot input{ flex: 1; border: 1px solid #d8d7d0; border-radius: 8px; padding: 9px 10px; font-size: 13.5px; font-family: inherit; }
      .sw-foot input:focus{ outline: 2px solid ${color}; outline-offset: 1px; }
      .sw-foot button{ background: ${color}; color: #fff; border: none; border-radius: 8px; padding: 0 14px; font-size: 13px; cursor: pointer; }
      .sw-foot button:disabled{ opacity: 0.5; cursor: default; }

      /* 2. lead capture card */
      .sw-lead{ align-self: stretch; background: #fff; border: 1px solid ${color}; border-radius: 10px; padding: 10px; display:flex; flex-direction:column; gap:6px; }
      .sw-lead p{ margin:0; font-size: 12.5px; color:#52514e; }
      .sw-lead input{ border: 1px solid #d8d7d0; border-radius: 6px; padding: 7px 9px; font-size: 13px; font-family: inherit; }
      .sw-lead-row{ display:flex; gap:6px; }
      .sw-lead-row button{ flex:1; border:none; border-radius:6px; padding: 7px 0; font-size: 12.5px; cursor:pointer; }
      .sw-lead-send{ background: ${color}; color:#fff; }
      .sw-lead-skip{ background: #eee; color:#52514e; }
    </style>
    <button class="sw-launcher" aria-label="Open chat">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16v12H7l-3 3V4z"/></svg>
    </button>
    <div class="sw-panel" role="dialog" aria-label="Chat with ${business}">
      <div class="sw-head">
        <div class="sw-head-text"><b>${business}</b><span>Usually replies instantly</span></div>
        <button class="sw-human-btn" id="sw-human">Talk to a person</button>
      </div>
      <div class="sw-body" id="sw-body"></div>
      <div class="sw-foot">
        <input id="sw-input" type="text" placeholder="Ask a question…" />
        <button id="sw-send">Send</button>
      </div>
    </div>
  `;

  var launcher = root.querySelector('.sw-launcher');
  var panel = root.querySelector('.sw-panel');
  var body = root.querySelector('#sw-body');
  var input = root.querySelector('#sw-input');
  var send = root.querySelector('#sw-send');
  var humanBtn = root.querySelector('#sw-human');

  function addMsg(text, who) {
    var el = document.createElement('div');
    el.className = 'sw-msg ' + who;
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  function showLeadForm(promptText) {
    if (leadCaptured) return;
    var card = document.createElement('div');
    card.className = 'sw-lead';
    card.innerHTML =
      '<p>' + (promptText || "Want us to follow up? Leave your email and we'll get back to you.") + '</p>' +
      '<input type="text" placeholder="Name (optional)" class="sw-lead-name" />' +
      '<input type="text" placeholder="Email or phone" class="sw-lead-contact" />' +
      '<div class="sw-lead-row">' +
        '<button class="sw-lead-send">Send</button>' +
        '<button class="sw-lead-skip">No thanks</button>' +
      '</div>';
    body.appendChild(card);
    body.scrollTop = body.scrollHeight;

    card.querySelector('.sw-lead-skip').addEventListener('click', function () { card.remove(); });
    card.querySelector('.sw-lead-send').addEventListener('click', function () {
      var name = card.querySelector('.sw-lead-name').value.trim();
      var contact = card.querySelector('.sw-lead-contact').value.trim();
      if (!contact) return;
      fetch(endpoint + '/api/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientId, sessionId: sessionId, name: name, contact: contact }),
      }).catch(function () {});
      leadCaptured = true;
      card.remove();
      addMsg('Thanks — someone will follow up shortly.', 'system');
    });
  }

  // 6. human handoff
  humanBtn.addEventListener('click', function () {
    addMsg("I've flagged this conversation for a person on the team.", 'system');
    fetch(endpoint + '/api/handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientId, sessionId: sessionId, reason: 'visitor requested a person', transcript: history }),
    }).catch(function () {});
    showLeadForm("Leave your email so they can reach you.");
  });

  var greeted = false;
  launcher.addEventListener('click', function () {
    panel.classList.toggle('open');
    if (!greeted) {
      addMsg("Hi! I'm " + business + "'s assistant — ask me about hours, pricing, or anything else.", 'bot');
      greeted = true;
    }
  });

  function sendMessage() {
    var text = input.value.trim();
    if (!text) return;
    addMsg(text, 'user');
    input.value = '';
    send.disabled = true;

    var botEl = addMsg('', 'bot');
    var accumulated = '';

    fetch(endpoint + '/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientId, sessionId: sessionId, message: text, history: history }),
    })
      .then(function (response) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        function pump() {
          return reader.read().then(function (result) {
            if (result.done) return;
            buffer += decoder.decode(result.value, { stream: true });
            var events = buffer.split('\n\n');
            buffer = events.pop(); // keep the last (possibly incomplete) event in the buffer

            events.forEach(function (evt) {
              var eventMatch = evt.match(/^event: (.+)$/m);
              var dataMatch = evt.match(/^data: (.+)$/m);
              if (!dataMatch) return;
              var data = JSON.parse(dataMatch[1]);
              var eventName = eventMatch ? eventMatch[1] : 'message';

              if (eventName === 'delta') {
                accumulated += data.text;
                botEl.textContent = accumulated;
                body.scrollTop = body.scrollHeight;
              } else if (eventName === 'done') {
                // 1. memory — record this turn once it's complete
                history.push({ role: 'user', content: text });
                history.push({ role: 'assistant', content: accumulated.trim() });
                if (data.captureLead) showLeadForm();
              } else if (eventName === 'error') {
                botEl.textContent = "Sorry, something went wrong. Try again shortly.";
              }
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function () {
        botEl.textContent = "Sorry, I couldn't reach the server. Try again shortly.";
      })
      .finally(function () {
        send.disabled = false;
      });
  }

  send.addEventListener('click', sendMessage);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') sendMessage();
  });
})();
