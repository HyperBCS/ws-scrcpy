const assert = require('node:assert/strict');
const { test } = require('node:test');
require('ts-node').register({ transpileOnly: true });
const { notificationTextParts: parts, notificationMediaLinks: media } = require('../src/app/ui/notificationContent');

test('links retain surrounding message text, line breaks, Unicode and balanced URL punctuation', () => {
    const text = '📷 See (https://example.com/photo_(1).jpg), then\n“https://example.com/movie.mp4?token=abc&v=2”.';
    const parsed = parts(text);
    assert.equal(parsed.map(p => p.text).join(''), text);
    assert.deepEqual(parsed.filter(p => p.href).map(p => [p.href, p.media]), [
        ['https://example.com/photo_(1).jpg', 'image'],
        ['https://example.com/movie.mp4?token=abc&v=2', 'video'],
    ]);
});

test('unsafe schemes, credentials, malformed URLs and backslash URLs stay plain text', () => {
    for (const text of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'file:///tmp/a.png',
        'https://user:password@example.com/a.png', 'https://', 'http://[bad', 'https://example.com\\@evil.test/a.png']) {
        assert.equal(parts(text).some(p => p.href), false, text);
        assert.equal(parts(text).map(p => p.text).join(''), text);
    }
});

test('only explicit web URLs become links, and embedded markup remains text', () => {
    const text = '<img src=x onerror=alert(1)> https://example.com/ <script>alert(2)</script>';
    assert.equal(parts(text).map(p => p.text).join(''), text);
    assert.deepEqual(parts(text).filter(p => p.href).map(p => p.href), ['https://example.com/']);
    assert.deepEqual(parts('No links here.'), [{ text: 'No links here.' }]);
    assert.deepEqual(parts(''), []);
});

test('HTTPS media uses the pathname, preserves signed queries and deduplicates across fields', () => {
    const image = 'https://cdn.example.com/My%20Photo.JPG?token=secret&size=300#preview';
    assert.deepEqual(media([image, image, 'https://cdn.example.com/clip.webm https://cdn.example.com/voice.m4a']), [
        { href: image, kind: 'image', host: 'cdn.example.com', name: 'My Photo.JPG' },
        { href: 'https://cdn.example.com/clip.webm', kind: 'video', host: 'cdn.example.com', name: 'clip.webm' },
        { href: 'https://cdn.example.com/voice.m4a', kind: 'audio', host: 'cdn.example.com', name: 'voice.m4a' },
    ]);
});

test('web pages, insecure media and active documents stay links without embeds', () => {
    for (const url of ['http://example.com/a.jpg', 'https://example.com/a.svg', 'https://example.com/page.html',
        'https://example.com/?file=a.jpg', 'https://youtube.com/watch?v=test', 'https://example.com/a.pdf']) {
        assert.equal(parts(url)[0].href, url);
        assert.deepEqual(media([url]), []);
    }
});

test('GIF/audio formats, malformed escaping, and large media lists are bounded', () => {
    assert.equal(media(['https://example.com/animated.gif'])[0].kind, 'image');
    assert.equal(media(['https://example.com/sound.ogg'])[0].kind, 'audio');
    assert.equal(media(['https://example.com/%broken.png'])[0].name, '%broken.png');
    assert.equal(media([Array.from({ length: 100 }, (_, i) => `https://example.com/${i}.png`).join(' ')]).length, 4);
    assert.deepEqual(media([undefined, '', 'Someone sent a photo']), []);
});

const { notificationStacks, notificationDay, notificationDayLabel, notificationTime } = require('../src/app/views/notifications/inbox');
const note = (key, changes = {}) => ({ key, source: 'a', app: 'chat', title: 'Sam', received: new Date(2026, 10, 12, 12).getTime(), ...changes });
test('notification stacks keep adjacent conversations together without crossing phones, days or missing titles', () => {
    const items = [note('a'), note('b'), note('c', { source: 'b' }), note('d'), note('e', { title: 'Alex' }), note('f', { received: new Date(2026, 10, 11, 23).getTime() }), note('g', { title: '' }), note('h', { title: '' }), note('i', { app: 'mail' }), note('j', { app: '' }), note('k', { app: '' })];
    assert.deepEqual(notificationStacks(items).map(stack => stack.map(n => n.key)), [['a', 'b'], ['c'], ['d'], ['e'], ['f'], ['g'], ['h'], ['i'], ['j'], ['k']]);
    assert.equal(items.length, 11, 'grouping leaves the history unchanged');
});
test('notification dates use local calendar days, with recent times kept short', () => {
    const now = new Date(2026, 10, 12, 12, 30).getTime();
    assert.equal(notificationDayLabel(now, now), 'Today');
    assert.equal(notificationDayLabel(new Date(2026, 10, 11, 23, 59).getTime(), now), 'Yesterday');
    assert.equal(notificationTime(now - 5000, now), 'Just now');
    assert.equal(notificationTime(now - 7 * 60000, now), '7 min ago');
    assert.equal(notificationTime(now - 60 * 60000, now), new Date(now - 60 * 60000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    assert.notEqual(notificationDay(now), notificationDay(now - 86400000));
    assert.notEqual(notificationDayLabel(now - 3 * 86400000, now), 'Yesterday');
});
