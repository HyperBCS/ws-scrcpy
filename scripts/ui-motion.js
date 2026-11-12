// Wait for finite UI transitions without disabling them or touching the remote stream.
async function settleMotion(page) {
    await page.evaluate(async () => {
        // With motion reduced every element transitions every property for 0.01ms (app.css). A
        // view that is hidden then turns its descendants hidden one level per frame, so a deep
        // view (Files behind the Shell tab) can take more than eight passes. It still ends.
        for (let pass = 0; pass < 32; pass++) {
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
