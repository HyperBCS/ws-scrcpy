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
