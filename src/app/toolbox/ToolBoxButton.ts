import { Optional, ToolBoxElement } from './ToolBoxElement';
import { iconButtonClass } from '../ui/IconButton';
import { iconSvg, IconName } from '../ui/icons';

export class ToolBoxButton extends ToolBoxElement<HTMLButtonElement> {
    private readonly btn: HTMLButtonElement;
    constructor(title: string, icon: IconName, optional?: Optional) {
        super(title, optional);
        const btn = document.createElement('button');
        btn.type = 'button';
        // The kit's icon button. `control-button` has no rule: the views and the browser checks
        // find the controls by it.
        btn.className = `${iconButtonClass({ variant: 'bare' })} control-button`;
        btn.title = title;
        btn.setAttribute('aria-label', title);
        btn.innerHTML = iconSvg(icon);
        this.btn = btn;
    }

    public getElement(): HTMLButtonElement {
        return this.btn;
    }
    public getAllElements(): HTMLElement[] {
        return [this.btn];
    }
}
