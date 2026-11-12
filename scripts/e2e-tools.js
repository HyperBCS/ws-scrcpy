// All device sockets are fixtures. No shell commands reach a real device.
const assert = require('node:assert/strict');
const { settleMotion } = require('./ui-motion');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');
// The one icon set, to tell which icon a terminal key shows.
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const { ICONS } = require('../src/app/ui/icons');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const UDID = 'tool-fixture-001';
const descriptor = (udid = UDID) => ({
    udid, state: 'device', pid: 123, interfaces: [],
    'ro.product.model': udid === UDID ? 'Phone A' : 'Phone B',
    'ro.product.manufacturer': 'Fixture', 'ro.build.version.sdk': '36',
    'ro.build.version.release': '16', 'screen.power': 'on', 'device.awake': true,
});
function frame(type, id, data) {
    const body = Buffer.from(data);
    const packet = Buffer.alloc(5 + body.length);
    packet[0] = type; packet.writeUInt32LE(id, 1); body.copy(packet, 5);
    return packet;
}
async function fixtures(page) {
    // close() drops the whole socket, as a server restart or a lost network does. endShell() closes
    // only the shell channel, as the server does when adb exits. While refuse is set, a new socket
    // is closed at once. While hold is set, a new socket stays connecting, as it does when the
    // network is gone.
    const state = { starts: [], input: [], resizes: [], closed: [], sends: [], update: undefined, close: undefined, endShell: undefined, output: undefined, refuse: false, hold: false };
    await page.routeWebSocket('**', async socket => {
        const url = new URL(socket.url());
        if (url.searchParams.get('action') === 'proxy-adb') {
            setTimeout(() => socket.send(initialStreamPacket()), 40);
            return;
        }
        // The page sees the socket open only once this handler returns.
        while (state.hold && !page.isClosed()) await new Promise(resolve => setTimeout(resolve, 25));
        if (state.refuse) {
            socket.close();
            return;
        }
        const channels = new Map();
        state.close = () => socket.close();
        socket.onMessage(data => {
            const packet = Buffer.from(data);
            if (packet.length < 5) return;
            const id = packet.readUInt32LE(1), body = packet.subarray(5).toString();
            const send = message => socket.send(frame(32, id, JSON.stringify(message)));
            if (packet[0] === 4) {
                channels.set(id, body);
                if (body === 'HSTS') send({id:-1,type:'hosts',data:{local:[{type:'android'}]}});
                if (body === 'GTRC') {
                    state.update = (patch = {}) => send({id:-1,type:'devicelist',data:{id:'tool-tracker',name:'Fixture host',list:[{...descriptor(),...patch},descriptor('tool-fixture-002')]}});
                    state.update();
                }
            } else if (packet[0] === 8) {
                state.closed.push(channels.get(id));
            } else if (packet[0] === 32 && channels.get(id) === 'SHEL') {
                if (body.startsWith('{')) {
                    const message = JSON.parse(body);
                    if (message.data?.type === 'start') {
                        state.starts.push(message.data);
                        // Output of the shell, as a program in it writes it.
                        state.output = text => socket.send(frame(32,id,text));
                        socket.send(frame(32,id,'Fixture terminal ready\r\n$ '));
                        state.endShell = (code = 1000) => { const body = Buffer.alloc(2); body.writeUInt16LE(code); socket.send(frame(8,id,body)); };
                    }
                } else state.input.push(body);
            } else if (packet[0] === 16 && channels.get(id) === 'SHEL') {
                // Shell messages after start travel in binary frames; text frames are typed input.
                const message = JSON.parse(body);
                if (message.data?.type === 'resize') state.resizes.push(message.data);
            } else state.sends.push(body);
        });
    });
    return state;
}
async function until(condition, label, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (!(await condition())) {
        if (Date.now() > deadline) throw Error(`Timed out waiting for: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}
async function geometry(page) {
    await settleMotion(page);
    const result = await page.evaluate(() => {
        const view = document.querySelector('.tool-view');
        const terminal = document.querySelector('.terminal-container');
        const box = view.getBoundingClientRect(), term = terminal.getBoundingClientRect();
        const coarse = matchMedia('(pointer: coarse)').matches;
        const controls = Array.from(document.querySelectorAll('.kit-tab,.kit-bar button'));
        // The kit's compact controls are 32px under a mouse and 44px under a finger.
        const least = el => el.matches('.kit-button-compact,.kit-icon-button-compact') && !coarse ? 32 : 44;
        const offScreen = r => r.x<0 || r.right>visualViewport.width+1 || r.bottom>visualViewport.height+1;
        const name = el => el.getAttribute('aria-label') || el.textContent;
        // The key row scrolls sideways, so a key may be out of view inside it; the row may not.
        const row = document.querySelector('.shell-keys');
        const keys = row ? Array.from(row.querySelectorAll('button')) : [];
        const workspace = document.querySelector('.tool-workspace');
        const mount = document.querySelector('.tool-mount').getBoundingClientRect();
        return { width:view.clientWidth, content:view.scrollWidth, height:box.height, viewport:visualViewport.height, terminalHeight:term.height,
            outside:controls.filter(el=>{ const r=el.getBoundingClientRect(); return offScreen(r) || r.width<least(el) || r.height<least(el); }).map(name),
            controls:controls.length, bodyScroll:document.scrollingElement.scrollTop, coarse,
            row: row && { offScreen:offScreen(row.getBoundingClientRect()), keys:keys.length,
                small:keys.filter(key=>{ const r=key.getBoundingClientRect(); return r.width<44 || r.height<44; }).map(name) },
            // What is left under the terminal: nothing but the workspace's own padding.
            under: workspace.getBoundingClientRect().bottom - parseFloat(getComputedStyle(workspace).paddingBottom) - mount.bottom };
    });
    assert(result.content <= result.width + 1, 'no horizontal page overflow');
    assert(result.height <= result.viewport + 1, 'tool fits visible viewport');
    assert(result.terminalHeight > 20, 'terminal retains usable space');
    assert.equal(result.controls, 5, 'Back, Switch and three tabs are measured');
    assert.deepEqual(result.outside, [], '44px controls fit visible viewport');
    assert.equal(result.bodyScroll,0);
    if (result.coarse) {
        assert.equal(result.row?.keys, 11, 'a touch screen has the key row');
        assert.equal(result.row.offScreen, false, 'the key row is on screen');
        assert.deepEqual(result.row.small, [], 'no key is under 44px');
    } else {
        assert.equal(result.row, null, 'a mouse and a keyboard have no key row');
        assert(Math.abs(result.under) <= 1, `the terminal takes the height of the row (${result.under}px under it)`);
    }
}
// A lost connection is retried without being asked and reported in one place. A shell that
// exits is not restarted behind the owner's back.
async function lostConnection(page, state, name) {
    const chip = page.locator('.tool-connection');
    const banner = page.locator('.tool-error');
    const terminalText = () => page.locator('.terminal-container .xterm-rows').innerText();
    const sessionsShown = async () => (await terminalText()).split('Fixture terminal ready').length - 1;
    const sessions = state.starts.length;

    state.close();
    await chip.getByText('Reconnecting…',{exact:true}).waitFor();
    assert.equal(await banner.count(),0,'no banner while reconnecting');
    const keysOn = () => page.locator('.shell-keys button').evaluateAll(keys=>keys.filter(key=>!key.disabled).map(key=>key.textContent));
    const touch = (await page.locator('.shell-keys').count()) > 0;
    if (touch) assert.deepEqual(await keysOn(),['Copy'],'only Copy is on while offline');
    await page.locator('.tool-connection.connected').waitFor({state:'attached'});
    await until(()=>state.starts.length===sessions+1,'the automatic attempt starts one new session');
    await until(async()=>await sessionsShown()===2,'the new session continues in the same terminal');
    assert(!/disconnected|reconnect/i.test(await terminalText()),'the terminal carries no instructions of its own');
    assert.equal(await banner.count(),0,'no banner after an automatic reconnect');

    state.endShell();
    await banner.getByText('The shell session ended.',{exact:true}).waitFor();
    assert.equal(await chip.innerText(),'Stopped');
    if (touch) {
        // The output of a session that ended can still be copied.
        await until(async()=>(await keysOn()).join()==='Copy','the keys that type are off');
        await page.evaluate(()=>navigator.clipboard.writeText(''));
        // A click on the terminal clears the selection the key row checks left.
        await page.locator('.terminal-container .xterm-screen').click();
        await page.locator('.shell-keys').getByRole('button',{name:'Copy',exact:true}).click();
        const toast = page.locator('.kit-toast');
        await toast.getByText('Copied the text on screen.',{exact:true}).waitFor();
        assert((await page.evaluate(()=>navigator.clipboard.readText())).includes('Fixture terminal ready'),'Copy works after the session ended');
        await toast.getByRole('button',{name:'Dismiss message',exact:true}).click();
        await toast.waitFor({state:'detached'});
    }
    await page.waitForTimeout(1600);
    assert.equal(state.starts.length,sessions+1,'a shell that exited is not restarted automatically');
    await banner.getByRole('button',{name:'New session',exact:true}).click();
    await page.locator('.tool-connection.connected').waitFor({state:'attached'});
    await until(()=>state.starts.length===sessions+2,'New session starts one session');
    await banner.waitFor({state:'detached'});

    // The retries take eleven seconds to run out, so two sizes are enough.
    if (name !== 'phone320' && name !== 'desktop') return;
    state.refuse = true;
    state.close();
    await chip.getByText('Reconnecting…',{exact:true}).waitFor();
    await banner.getByText('Connection lost.',{exact:true}).waitFor({timeout:20000});
    assert.equal(await chip.innerText(),'Unable to connect');
    assert.equal(await chip.getAttribute('data-tone'),'error');
    assert.equal(await page.getByText(/reconnect/i).count(),1,'one instruction: the Reconnect button');
    assert.equal(state.starts.length,sessions+2,'nothing starts while the server is away');
    const button = banner.getByRole('button',{name:'Reconnect',exact:true});
    // A tool that fails to load puts a long message here. The button must not give way to it.
    await banner.locator('span').evaluate(el=>{ el.textContent='A message long enough to need several lines at this width, as a failed load can produce.'; });
    const fit = await button.evaluate(el=>{ const range=document.createRange(); range.selectNodeContents(el); const box=el.getBoundingClientRect(); return {lines:range.getClientRects().length,right:box.right,width:innerWidth}; });
    assert.equal(fit.lines,1,'the Reconnect label stays on one line');
    assert(fit.right<=fit.width,'the Reconnect button stays on screen');
    await page.screenshot({path:`/tmp/ws-scrcpy-tools/${name}-shell-lost.png`});
    state.refuse = false;
    await button.click();
    await page.locator('.tool-connection.connected').waitFor({state:'attached'});
    await until(()=>state.starts.length===sessions+3,'Reconnect starts one session');
    await banner.waitFor({state:'detached'});
}
async function main() {
    const browser = await chromium.launch({headless:true});
    try {
        for (const [name,width,height,mobile] of [['phone320',320,568,true],['iphone17pm',440,956,true],['iphone17pm-landscape',956,440,true],['desktop',1280,800,false]]) {
            const context = await browser.newContext({viewport:{width,height},isMobile:mobile,hasTouch:mobile,permissions:['clipboard-read','clipboard-write']});
            const page = await context.newPage(), errors=[];
            page.on('pageerror', error=>errors.push(error.message));
            const state = await fixtures(page);
            await page.goto(BASE);
            const card = page.locator('.device').filter({hasText:'Phone A'});
            await card.getByRole('link',{name:'Shell',exact:true}).click();
            await page.locator('.tool-connection.connected').waitFor({state:'attached'});
            await page.locator('.terminal-container .xterm').waitFor();
            assert.equal(context.pages().length,1,'local tools stay in the current app');
            assert.equal(state.starts.length,1);
            assert.equal(state.starts[0].udid,UDID);
            assert(state.starts[0].cols>0 && state.starts[0].rows>0,'terminal starts with valid dimensions');
            await geometry(page);
            // The terminal keys are the kit's buttons, on a touch screen only. The ones without
            // words are icon buttons with a name and an icon of the one set; none is drawn with a
            // character.
            const keys = await page.locator('.shell-keys > *').evaluateAll(list=>list.map(key=>({
                kit:key.matches('button.kit-button.kit-button-compact, button.kit-icon-button.kit-icon-button-compact'),
                name:key.getAttribute('aria-label') || key.textContent, text:key.textContent, path:key.querySelector('svg.kit-icon > path')?.getAttribute('d') })));
            const word = (name, text = name) => ({kit:true,name,text,path:undefined});
            const arrow = (name, path) => ({kit:true,name,text:'',path});
            assert.deepEqual(keys,mobile ? [
                word('Esc'),word('Tab'),word('Ctrl'),
                arrow('Left arrow',ICONS.arrowLeft),arrow('Up arrow',ICONS.arrowUp),arrow('Down arrow',ICONS.arrowDown),arrow('Right arrow',ICONS.arrowRight),
                word('Paste'),word('Copy'),word('Smaller text','A−'),word('Larger text','A+')] : [],'the terminal keys');
            if (mobile) assert.equal(await page.getByRole('group',{name:'Terminal keys',exact:true}).count(),1,'the row is named');
            assert.equal(await page.locator('header.kit-bar').count(),1,'the tool header is the kit bar');
            assert.deepEqual(await page.locator('h1').evaluateAll(list=>list.map(h1=>h1.className)),['kit-bar-name'],'one h1, the name in the bar');
            fs.mkdirSync('/tmp/ws-scrcpy-tools', {recursive:true});
            await page.screenshot({path:`/tmp/ws-scrcpy-tools/${name}-shell.png`});
            // The header names the stream service only while it does not run (p5-screen-shell).
            const service = page.locator('.kit-bar .stream-service-status');
            assert.equal(await service.count(),0,'a running service has no line in the header');
            state.update({pid:-1});
            await page.locator('.stream-service-status[data-stream-service="stopped"]').waitFor();
            state.update({pid:0});
            await page.locator('.stream-service-status[data-stream-service="unknown"]').waitFor();
            state.update({pid:123,'screen.power':'off','device.awake':false});
            await service.waitFor({state:'detached'});
            let typed;
            if (mobile) {
                await page.getByRole('button',{name:'Tab',exact:true}).click();
                const ctrl = page.getByRole('button',{name:'Ctrl',exact:true});
                // Ctrl is one-shot. Left on, it would turn "ls" and Enter into ^L ^S, which clears
                // the screen and freezes output.
                const pressed = () => ctrl.getAttribute('aria-pressed');
                await ctrl.click();
                assert.equal(await pressed(),'true','Ctrl shows as held');
                await page.keyboard.type('c');
                await until(async()=>await pressed()==='false','Ctrl releases after one character');
                await page.keyboard.type('l');
                await ctrl.click();
                await page.keyboard.press('ArrowUp');
                await page.waitForTimeout(50);
                assert.equal(await pressed(),'true','an arrow key leaves Ctrl waiting for a character');
                await page.keyboard.type('d');
                await until(async()=>await pressed()==='false','Ctrl releases after the next character');
                await ctrl.click();
                await ctrl.click();
                assert.equal(await pressed(),'false','a second tap cancels Ctrl');
                await page.keyboard.type('c');
                await page.waitForTimeout(50);
                typed = ['\t','\x03','l','\x1b[A','\x04','c'];
                assert.deepEqual(state.input,typed,'Ctrl changes one character and never an escape sequence');
            } else {
                // With a mouse and a keyboard the terminal has the keyboard from the start.
                await page.keyboard.type('pwd');
                await page.keyboard.press('ArrowLeft');
                await page.waitForTimeout(50);
                typed = ['p','w','d','\x1b[D'];
                assert.deepEqual(state.input,typed,'the keyboard types into the terminal');
            }
            // The remote pty follows the terminal. The phone keyboard and a shorter window change
            // the rows, a narrower window the columns.
            const shownRows = () => page.locator('.terminal-container .xterm-rows > div').count();
            const started = state.starts[0];
            assert.equal(await shownRows(),started.rows,'the terminal shows the rows it started with');
            assert.deepEqual(state.resizes,[],'no resize is sent while the size is unchanged');
            await page.setViewportSize({width,height:320});
            await page.waitForFunction(()=>document.querySelector('.tool-view').getBoundingClientRect().height <= visualViewport.height+1);
            if(mobile) await geometry(page);
            await until(async()=>{ const last=state.resizes.at(-1); return !!last && last.rows<started.rows && last.rows===await shownRows(); },'the smaller row count reaches the device');
            assert.equal(state.resizes.at(-1).cols,started.cols,'a height change keeps the columns');
            if(!mobile) {
                await page.setViewportSize({width:900,height:320});
                await until(()=>state.resizes.at(-1).cols<started.cols,'the smaller column count reaches the device');
            }
            await page.setViewportSize({width,height});
            await page.waitForFunction(()=>Math.abs(document.querySelector('.tool-view').getBoundingClientRect().height-visualViewport.height)<1);
            await until(()=>{ const last=state.resizes.at(-1); return last.cols===started.cols && last.rows===started.rows; },'the restored size reaches the device');
            assert.deepEqual(state.input,typed,'a resize is never typed into the shell');
            if(mobile) await keyRow(page,state,name);
            await lostConnection(page,state,name);
            if(!mobile) {
                // A very tall window fits more rows than the server accepts, and an out-of-range
                // start message is refused. The device is told the largest size it takes.
                await page.setViewportSize({width,height:10000});
                await until(()=>state.resizes.at(-1).rows===500,'a tall terminal reports 500 rows');
                assert(await shownRows()>500,'the terminal itself shows more rows');
                const before = state.starts.length;
                state.close();
                await until(()=>state.starts.length===before+1,'the automatic attempt starts a session');
                assert.equal(state.starts.at(-1).rows,500,'a new session starts at 500 rows');
                await page.setViewportSize({width,height});
                await page.locator('.tool-connection.connected').waitFor({state:'attached'});
                await until(()=>state.resizes.at(-1).rows===started.rows,'the restored size reaches the device');
            }
            const sessions = state.starts.length;
            await page.getByRole('button',{name:'Switch',exact:true}).click();
            const sheet=page.locator('dialog.kit-sheet[open]');
            await sheet.getByRole('button',{name:/Phone B/}).click();
            await page.waitForFunction(()=>location.hash.includes('tool-fixture-002') && document.querySelector('.tool-connection.connected'));
            await page.waitForTimeout(100);
            assert.equal(state.starts.length,sessions+1,'device switching creates one replacement terminal');
            assert.equal(state.starts.at(-1).udid,'tool-fixture-002');
            assert(state.closed.includes('SHEL'),'old shell channel is closed');
            // The tabs of the phone's page: the screen, then the tools.
            assert.deepEqual(await page.locator('nav.kit-tabs .kit-tab').allInnerTexts(),['Screen','Files','Shell']);
            await page.getByRole('button',{name:'Files',exact:true}).click();
            await page.locator('.file-listing-client').waitFor();
            // A tab change hides the shell and keeps its session. Leaving the page ends it.
            assert.equal(await page.locator('.terminal-container:visible').count(),0,'the terminal is hidden while Files is shown');
            assert.equal(state.closed.filter(code=>code==='SHEL').length,1,'the shell of the phone before is closed; this one stays open behind Files');
            // Files reports a lost connection the same way and comes back by itself.
            await page.locator('.tool-connection.connected').waitFor({state:'attached'});
            state.refuse = true;
            state.close();
            await until(()=>page.locator('.file-explorer.fx-offline .fx-empty').evaluateAll(cells=>cells.length===1 && cells[0].textContent===''),'a folder that was never listed is not called empty while offline');
            assert.equal(await page.locator('.fx-status').innerText(),'','Files leaves the message to the tool page');
            await page.locator('.tool-connection').getByText('Reconnecting…',{exact:true}).waitFor();
            assert.equal(await page.locator('.tool-error').count(),0,'no banner while Files reconnects');
            // The next attempt mounts Files again. Until its socket opens, nothing has been listed.
            state.hold = true;
            state.refuse = false;
            await page.locator('.file-explorer:not(.fx-offline) .fx-empty').waitFor({state:'attached',timeout:5000});
            await page.waitForTimeout(300);
            assert.equal(await page.locator('.file-explorer .fx-empty').innerText(),'','a folder is not called empty while the attempt is connecting');
            assert.equal(await page.locator('.tool-connection').innerText(),'Reconnecting…');
            state.hold = false;
            await page.locator('.tool-connection.connected').waitFor({state:'attached'});
            assert.equal(await page.locator('.file-explorer').count(),1,'Files is mounted once after reconnecting');
            assert.equal(await page.locator('.file-explorer.fx-offline').count(),0);
            await page.getByRole('button',{name:'Phones',exact:true}).click();
            await page.locator('#devices').waitFor();
            assert.equal(await page.locator('.terminal-container').count(),0,'leaving the page removes the terminal');
            const card2 = page.locator('.device').filter({hasText:'Phone B'});
            await card2.getByRole('link',{name:'Open screen',exact:true}).click();
            await page.locator('.stream-stage').waitFor();
            await page.getByText('Connected',{exact:true}).waitFor();
            await page.getByRole('button',{name:'Phones',exact:true}).click();
            await page.locator('#devices').waitFor();
            assert.deepEqual(errors,[]);
            console.log('PASS',name,'in-app tools, status transitions, shell input, switching, cleanup and viewport');
            await context.close();
        }
        await rememberedSize(browser);
        await missingCode(browser);
    } finally { await browser.close(); }
}
// The key row of a touch screen (views/shell/ShellKeys.tsx): one row that scrolls sideways, the
// arrows in the mode the terminal is in, Paste and Copy, and the text size.
async function keyRow(page, state, name) {
    const row = page.locator('.shell-keys');
    const key = label => row.getByRole('button',{name:label,exact:true});
    const toast = page.locator('.kit-toast');
    const sent = async (press, expected, label) => {
        const before = state.input.length;
        await press();
        await until(()=>state.input.length>=before+expected.length,label);
        await page.waitForTimeout(100);
        assert.deepEqual(state.input.slice(before),expected,label);
    };
    const quietly = async () => page.waitForTimeout(150);

    const scroll = await row.evaluate(el=>{
        const fits = el.scrollWidth<=el.clientWidth+1;
        el.scrollLeft = el.scrollWidth;
        const last = el.lastElementChild.getBoundingClientRect(), box = el.getBoundingClientRect();
        const result = { fits, moved:el.scrollLeft>0, lastShown:last.left>=box.left-1 && last.right<=box.right+1, page:document.scrollingElement.scrollWidth<=innerWidth };
        el.scrollLeft = 0;
        return result;
    });
    if (name==='phone320' || name==='iphone17pm') assert.equal(scroll.fits,false,`${name}: the row is wider than a phone held upright`);
    if (!scroll.fits) assert(scroll.moved && scroll.lastShown,`${name}: the row scrolls sideways to its last key`);
    assert(scroll.page,`${name}: the page itself does not scroll sideways`);

    await sent(async()=>{ for (const label of ['Left arrow','Up arrow','Down arrow','Right arrow']) await key(label).click(); },
        ['\x1b[D','\x1b[A','\x1b[B','\x1b[C'],'each arrow sends its escape sequence');
    // A full-screen program turns on application cursor keys, and the arrows follow it.
    state.output('\x1b[?1h');
    await quietly();
    await sent(()=>key('Left arrow').click(),['\x1bOD'],'in application cursor mode an arrow is ESC O');
    state.output('\x1b[?1l');
    await quietly();
    await sent(()=>key('Esc').click(),['\x1b'],'Esc');

    // Paste reads the clipboard on the press and sends it once.
    const clipboard = text => page.evaluate(value=>navigator.clipboard.writeText(value),text);
    await clipboard('echo one\nls');
    await sent(()=>key('Paste').click(),['echo one\rls'],'Paste sends the clipboard once, each line end as Enter');
    state.output('\x1b[?2004h');
    await quietly();
    await clipboard('pwd');
    await sent(()=>key('Paste').click(),['\x1b[200~pwd\x1b[201~'],'bracketed only when the program asked for it');
    state.output('\x1b[?2004l');
    await quietly();
    // A browser that refuses to read the clipboard: a toast says so, and nothing is sent.
    await page.evaluate(()=>{ navigator.clipboard.readText = () => Promise.reject(new DOMException('Read permission denied.','NotAllowedError')); });
    const before = state.input.length;
    await key('Paste').click();
    await toast.getByText('This browser blocked reading the clipboard.',{exact:true}).waitFor();
    assert.equal(await toast.getAttribute('role'),'alert');
    await quietly();
    assert.equal(state.input.length,before,'nothing is sent when the browser refuses');
    await page.evaluate(()=>{ delete navigator.clipboard.readText; });
    await toast.getByRole('button',{name:'Dismiss message',exact:true}).click();
    await toast.waitFor({state:'detached'});
    // On the plain http address the browser has no clipboard read at all, and the toast says why.
    await clipboard('ls');
    const secure = await page.evaluateHandle(()=>{
        const own = Object.getOwnPropertyDescriptor(window,'isSecureContext');
        Object.defineProperty(window,'isSecureContext',{value:false,configurable:true});
        return own;
    });
    await key('Paste').click();
    await toast.getByText("Paste needs this app's secure (HTTPS) address.",{exact:true}).waitFor();
    await quietly();
    assert.equal(state.input.length,before,'nothing is sent on an http address');
    await secure.evaluate(own=>{ delete window.isSecureContext; if (own) Object.defineProperty(window,'isSecureContext',own); });
    assert.equal(await page.evaluate(()=>window.isSecureContext),true);
    await toast.getByRole('button',{name:'Dismiss message',exact:true}).click();
    await toast.waitFor({state:'detached'});

    // Copy with nothing selected copies the text on screen, and the selection when there is one.
    await clipboard('');
    await key('Copy').click();
    await toast.getByText('Copied the text on screen.',{exact:true}).waitFor();
    // The toast stands above the row: every key in view can still be pressed.
    await settleMotion(page);
    const covered = await row.evaluate(el=>{
        const box = el.getBoundingClientRect();
        return Array.from(el.querySelectorAll('button')).filter(button=>{
            const r = button.getBoundingClientRect();
            const x = r.x + r.width/2, y = r.y + r.height/2;
            return x>box.left && x<box.right && !button.contains(document.elementFromPoint(x,y));
        }).map(button=>button.getAttribute('aria-label') || button.textContent);
    });
    assert.deepEqual(covered,[],'the toast covers no key');
    const shown = await page.evaluate(()=>navigator.clipboard.readText());
    const rows = await page.locator('.terminal-container .xterm-rows > div').count();
    assert(shown.includes('Fixture terminal ready'),'the visible output is copied');
    assert(shown.split('\n').length<=rows && !/\s$/.test(shown),'the rows on screen, without trailing blanks');
    await toast.getByRole('button',{name:'Dismiss message',exact:true}).click();
    await toast.waitFor({state:'detached'});
    const line = page.locator('.terminal-container .xterm-rows > div').filter({hasText:'Fixture terminal ready'}).first();
    await line.dblclick({position:{x:12,y:6}});
    await key('Copy').click();
    await toast.getByText('Copied the selected text.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'Fixture','Copy copies the selection');
    await toast.getByRole('button',{name:'Dismiss message',exact:true}).click();
    await toast.waitFor({state:'detached'});
    assert.equal(state.input.length,before,'Copy sends nothing to the shell');

    // A+ and A−: other columns and rows, and the phone is told once for each press.
    const now = state.resizes.at(-1) ?? state.starts.at(-1);
    const resizes = state.resizes.length;
    await key('Larger text').click();
    await until(()=>state.resizes.length===resizes+1,'A+ resizes the phone terminal');
    await page.waitForTimeout(300);
    assert.equal(state.resizes.length,resizes+1,'once');
    const larger = state.resizes.at(-1);
    assert(larger.cols<now.cols && larger.rows<now.rows,`larger text has fewer columns and rows (${now.cols}x${now.rows} to ${larger.cols}x${larger.rows})`);
    assert.equal(await page.locator('.terminal-container .xterm-rows > div').count(),larger.rows,'the terminal shows the rows the phone was told');
    assert.equal(await page.evaluate(()=>localStorage.getItem('ws-scrcpy.shell.text-size')),'16','kept in this browser');
    await key('Smaller text').click();
    await until(()=>state.resizes.length===resizes+2,'A− resizes it back');
    await page.waitForTimeout(300);
    assert.equal(state.resizes.length,resizes+2,'once');
    assert.deepEqual([state.resizes.at(-1).cols,state.resizes.at(-1).rows],[now.cols,now.rows],'back to the size it had');
    assert.equal(state.input.length,before,'a size is never typed into the shell');
}
// The text size is kept per browser: a reload starts the next session at it. Also the shell in
// the dark theme, on a phone and on a desktop.
async function rememberedSize(browser) {
    for (const [name,width,height,mobile] of [['phone390-dark',390,844,true],['desktop-dark',1280,800,false]]) {
        const context = await browser.newContext({viewport:{width,height},isMobile:mobile,hasTouch:mobile,colorScheme:'dark'});
        const page = await context.newPage(), errors=[];
        page.on('pageerror', error=>errors.push(error.message));
        const state = await fixtures(page);
        await page.goto(BASE);
        await page.locator('.device').filter({hasText:'Phone A'}).getByRole('link',{name:'Shell',exact:true}).click();
        await page.locator('.tool-connection.connected').waitFor({state:'attached'});
        await page.locator('.terminal-container .xterm').waitFor();
        await geometry(page);
        if (mobile) {
            const larger = page.getByRole('button',{name:'Larger text',exact:true});
            const smaller = page.getByRole('button',{name:'Smaller text',exact:true});
            await larger.click();
            await until(()=>state.resizes.length===1,'A+ to 16px');
            await larger.click();
            await until(()=>state.resizes.length===2,'A+ to 18px');
            assert(await larger.isDisabled(),'18px is the largest size');
            const size = state.resizes.at(-1);
            await page.reload();
            await page.locator('.tool-connection.connected').waitFor({state:'attached'});
            await until(()=>state.starts.length===2,'the page starts a new session');
            assert.deepEqual([state.starts[1].cols,state.starts[1].rows],[size.cols,size.rows],'the new session starts at the kept size');
            await page.waitForTimeout(300);
            assert.equal(state.resizes.length,2,'and no resize follows its start');
            assert(await larger.isDisabled(),'the row shows the kept size');
            for (const count of [3,4,5]) {
                await smaller.click();
                await until(()=>state.resizes.length===count,`A− to ${[16,14,12][count-3]}px`);
            }
            assert(await smaller.isDisabled(),'12px is the smallest size');
            assert(state.resizes.at(-1).cols>state.starts[0].cols,'smaller text has more columns than the default');
            await smaller.evaluate(el=>el.closest('.shell-keys').scrollLeft=0);
        } else {
            // A touch screen attached to the computer: the row follows the pointer, the terminal
            // gives it its height, and the session goes on.
            const cdp = await context.newCDPSession(page);
            const rows = state.starts[0].rows;
            await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
            await page.locator('.shell-keys').waitFor();
            await until(()=>state.resizes.at(-1)?.rows<rows,'the phone is told the shorter terminal');
            await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
            await page.locator('.shell-keys').waitFor({state:'detached'});
            await until(()=>state.resizes.at(-1)?.rows===rows,'and the full height again');
            await geometry(page);
            assert.equal(state.starts.length,1,'the session is not started again');
        }
        await page.screenshot({path:`/tmp/ws-scrcpy-tools/${name}-shell.png`});
        assert.deepEqual(errors,[]);
        console.log('PASS',name,mobile ? 'the text size is kept in this browser and the next session starts at it' : 'the key row follows the pointer, and with a mouse the terminal takes its height');
        await context.close();
    }
}
// After a deploy the page still names the old content-hashed chunks, which are gone. Reconnecting
// would ask for the same names again, so the tool page offers a reload instead.
async function missingCode(browser) {
    const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const page = await context.newPage(), errors=[];
    page.on('pageerror', error=>errors.push(error.message));
    await fixtures(page);
    let blocked = false;
    await page.route('**/*.js', async route => {
        const response = await route.fetch();
        // The Shell chunk is the one that builds the terminal container.
        if (!route.request().url().endsWith('/bundle.js') && (await response.text()).includes('terminal-container')) {
            blocked = true;
            return route.fulfill({status:404,body:'gone'});
        }
        return route.fulfill({response});
    });
    await page.goto(BASE);
    const card = page.locator('.device').filter({hasText:'Phone A'});
    await card.getByRole('link',{name:'Shell',exact:true}).click();
    // The page's state card in place of the tool (p5-screen-shell).
    const offer = page.locator('.tool-state .stream-state-card');
    await offer.getByRole('heading',{name:'Shell could not be loaded',exact:true}).waitFor();
    assert(blocked,'the fixture refused the Shell chunk');
    assert.equal(await offer.getByRole('button').innerText(),'Reload','the card offers a reload, not a reconnect');
    await page.unroute('**/*.js');
    await Promise.all([page.waitForEvent('load'), offer.getByRole('button',{name:'Reload',exact:true}).click()]);
    await page.locator('.terminal-container .xterm').waitFor();
    assert.deepEqual(errors,[]);
    console.log('PASS a tool whose code is gone after a deploy offers Reload, which opens it');
    await context.close();
}
if(require.main===module) main().catch(error=>{ console.error(error); process.exitCode=1; });
module.exports={fixtures,descriptor,frame};
