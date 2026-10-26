// Wait for finite UI transitions without disabling them or touching the remote stream.
async function settleMotion(page) {
    await page.evaluate(async () => {
        for (let pass = 0; pass < 8; pass++) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const active = document.getAnimations().filter(animation =>
                animation.playState === 'running' && animation.effect?.getComputedTiming().endTime !== Infinity,
            );
            if (!active.length) return;
            await Promise.allSettled(active.map(animation => animation.finished));
        }
        throw new Error('UI animations did not settle');
    });
}
module.exports = { settleMotion };
