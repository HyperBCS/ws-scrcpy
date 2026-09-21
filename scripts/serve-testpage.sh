#!/usr/bin/env bash
# Serves the e2e test page (tap target + text field) on :8099 for the device to load.
# The device fetches it over the LAN, so the browser tests can read back what actually
# arrived on the device instead of inferring it from system UI state.
set -euo pipefail
DIR="${1:-$HOME/.cache/wsshot/kbtest}"
mkdir -p "$DIR"
cat > "$DIR/index.html" <<'HTML'
<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<body style="font:24px sans-serif;padding:20px">
<input id=i autofocus style="font-size:28px;width:90%;padding:12px" placeholder="type here">
<div>echo: <b id=o>(nothing)</b></div>
<button id=btn style="margin-top:40px;width:90%;height:220px;font-size:32px">TAP TARGET</button>
<div>taps: <b id=t>0</b></div>
<script>
const i=document.getElementById('i'),o=document.getElementById('o'),b=document.getElementById('btn'),t=document.getElementById('t');
let n=0;
i.addEventListener('input',()=>{o.textContent=i.value||'(empty)'});
b.addEventListener('click',()=>{n++;t.textContent=String(n)});
setTimeout(()=>i.focus(),300);
</script>
HTML
fuser -k 8099/tcp 2>/dev/null || true
sleep 1
cd "$DIR" && exec python3 -m http.server 8099 --bind 0.0.0.0
