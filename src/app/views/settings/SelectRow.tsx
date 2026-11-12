import { ComponentChildren } from 'preact';
import { SelectField, SelectOption } from '../../ui/Field';
import { SheetRow } from '../../ui/SheetControls';

interface SelectRowProps {
    /** Names the row for tests and for the stylesheet (`data-setting`). */
    name: string;
    title: string;
    description: ComponentChildren;
    value: string;
    options: ReadonlyArray<SelectOption>;
    disabled?: boolean;
    /** `stack` keeps the select under the text at every width, for long option names. */
    layout?: 'pair' | 'stack';
    onChange: (value: string) => void;
}

/** A setting chosen from a list: the select beside its text, and under it on a phone. */
export function SelectRow({
    name,
    title,
    description,
    value,
    options,
    disabled,
    layout = 'pair',
    onChange,
}: SelectRowProps) {
    return (
        <SheetRow title={title} description={description} layout={layout} attributes={{ 'data-setting': name }}>
            <SelectField
                label={title}
                labelHidden
                value={value}
                options={options}
                disabled={disabled}
                onChange={(event) => onChange(event.currentTarget.value)}
            />
        </SheetRow>
    );
}
