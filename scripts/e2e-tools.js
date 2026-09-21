/* eslint-disable */
// All device sockets are fixtures. No shell commands reach a real device.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { initialStreamPacket } = require('./e2e-sheets');
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
    const state = { starts: [], input: [], closed: [], sends: [], update: undefined, close: undefined };
    await page.routeWebSocket('**', socket => {
        const url = new URL(socket.url());
        if (url.searchParams.get('action') === 'proxy-adb') {
            setTimeout(() => socket.send(initialStreamPacket()), 40);
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
                        socket.send(frame(32,id,'Fixture terminal ready\r\n$ '));
                    }
                } else state.input.push(body);
            } else state.sends.push(body);
        });
    });
    return state;
}
async function geometry(page) {
    const result = await page.evaluate(() => {
        const view = document.querySelector('.tool-view');
        const terminal = document.querySelector('.terminal-container');
        const box = view.getBoundingClientRect(), term = terminal.getBoundingClientRect();
        const controls = Array.from(document.querySelectorAll('.tool-navigation button,.shell-shortcuts button,.stream-header button'));
        return { width:view.clientWidth, content:view.scrollWidth, height:box.height, viewport:visualViewport.height, terminalHeight:term.height,
            outside:controls.filter(el=>{ const r=el.getBoundingClientRect(); return r.x<0 || r.right>visualViewport.width+1 || r.bottom>visualViewport.height+1 || r.width<44 || r.height<44; }).map(el=>el.textContent),
            bodyScroll:document.scrollingElement.scrollTop };
    });
    assert(result.content <= result.width + 1, 'no horizontal page overflow');
    assert(result.height <= result.viewport + 1, 'tool fits visible viewport');
    assert(result.terminalHeight > 20, 'terminal retains usable space');
    assert.deepEqual(result.outside, [], '44px controls fit visible viewport');
    assert.equal(result.bodyScroll,0);
}
async function main() {
    const browser = await chromium.launch({headless:true});
    try {
        for (const [name,width,height,mobile] of [['phone320',320,568,true],['iphone17pm',440,956,true],['iphone17pm-landscape',956,440,true],['desktop',1280,800,false]]) {
            const context = await browser.newContext({viewport:{width,height},isMobile:mobile,hasTouch:mobile});
            const page = await context.newPage(), errors=[];
            page.on('pageerror', error=>errors.push(error.message));
            const state = await fixtures(page);
            await page.goto(BASE);
            const card = page.locator('.device').filter({hasText:'Phone A'});
            await card.locator('summary').click();
            await card.getByRole('link',{name:'Shell',exact:true}).click();
            await page.locator('.tool-connection.connected').waitFor({state:'attached'});
            await page.locator('.terminal-container .xterm').waitFor();
            assert.equal(context.pages().length,1,'local tools stay in the current app');
            assert.equal(state.starts.length,1);
            assert.equal(state.starts[0].udid,UDID);
            assert(state.starts[0].cols>0 && state.starts[0].rows>0,'terminal starts with valid dimensions');
            await geometry(page);
            fs.mkdirSync('/tmp/ws-scrcpy-tools', {recursive:true});
            await page.screenshot({path:`/tmp/ws-scrcpy-tools/${name}-shell.png`});
            await page.locator('.stream-service-status[data-stream-service="running"]').waitFor();
            state.update({pid:-1});
            await page.locator('.stream-service-status[data-stream-service="stopped"]').waitFor();
            state.update({pid:0});
            await page.locator('.stream-service-status[data-stream-service="unknown"]').waitFor();
            state.update({pid:123,'screen.power':'off','device.awake':false});
            await page.locator('.stream-service-status[data-stream-service="running"]').waitFor();
            await page.getByRole('button',{name:'Tab',exact:true}).click();
            const ctrl = page.getByRole('button',{name:'Ctrl',exact:true});
            await ctrl.click();
            assert.equal(await ctrl.getAttribute('aria-pressed'),'true','Ctrl shows as held');
            await page.keyboard.type('c');
            await page.keyboard.type('l');
            await ctrl.click();
            assert.equal(await ctrl.getAttribute('aria-pressed'),'false','Ctrl releases on the second tap');
            await page.keyboard.type('c');
            await page.waitForTimeout(50);
            assert.deepEqual(state.input,['\t','\x03','\x0c','c'],'Ctrl rewrites every key while held and nothing after');
            if(mobile) {
                await page.setViewportSize({width,height:320});
                await page.waitForFunction(()=>document.querySelector('.tool-view').getBoundingClientRect().height <= visualViewport.height+1);
                await geometry(page);
                await page.setViewportSize({width,height});
                await page.waitForFunction(()=>Math.abs(document.querySelector('.tool-view').getBoundingClientRect().height-visualViewport.height)<1);
            }
            await page.getByRole('button',{name:'Switch',exact:true}).click();
            const sheet=page.locator('.bottom-sheet-root.open');
            await sheet.getByRole('button',{name:/Phone B/}).click();
            await page.waitForFunction(()=>location.hash.includes('tool-fixture-002') && document.querySelector('.tool-connection.connected'));
            await page.waitForTimeout(100);
            assert.equal(state.starts.length,2,'device switching creates one replacement terminal');
            assert.equal(state.starts[1].udid,'tool-fixture-002');
            assert(state.closed.includes('SHEL'),'old shell channel is closed');
            // The tools navigation is Files and Shell only: the screen is started from the device list.
            assert.deepEqual(await page.locator('.tool-navigation button').allInnerTexts(),['Files','Shell']);
            await page.getByRole('button',{name:'Files',exact:true}).click();
            await page.locator('.file-listing-client').waitFor();
            assert.equal(await page.locator('.terminal-container').count(),0,'terminal removes all DOM on navigation');
            assert.equal(state.closed.filter(code=>code==='SHEL').length,2,'both departed shells closed');
            await page.getByRole('button',{name:'Back to devices',exact:true}).click();
            await page.locator('#devices').waitFor();
            const card2 = page.locator('.device').filter({hasText:'Phone B'});
            await card2.getByRole('link',{name:'Open screen →',exact:true}).click();
            await page.locator('.stream-stage').waitFor();
            await page.getByText('Connected',{exact:true}).waitFor();
            await page.getByRole('button',{name:'Back to devices',exact:true}).click();
            await page.locator('#devices').waitFor();
            assert.deepEqual(errors,[]);
            console.log('PASS',name,'in-app tools, status transitions, shell input, switching, cleanup and viewport');
            await context.close();
        }
    } finally { await browser.close(); }
}
if(require.main===module) main().catch(error=>{ console.error(error); process.exitCode=1; });
module.exports={fixtures,descriptor,frame};
