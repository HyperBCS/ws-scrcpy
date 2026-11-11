import { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';
import { Icon } from './Icon';
import '../../style/kit/Field.css';

interface FieldParts {
    /** The name of the field. Shown above it unless `labelHidden`. */
    label: string;
    /** Keeps the name for assistive technology only, where the row already shows it. */
    labelHidden?: boolean;
    hint?: ComponentChildren;
    /** What is wrong with the value. It replaces the hint and marks the field invalid. */
    error?: ComponentChildren;
    /** `short` is a narrow, centred field for a value such as a time of day. */
    width?: 'full' | 'short';
}

interface Wiring {
    id: string;
    class: string;
    'aria-label'?: string;
    'aria-describedby'?: string;
    'aria-invalid'?: 'true';
}

/** The label, the hint and the error around a control, and the attributes that tie them to it. */
function FieldGroup({
    label,
    labelHidden = false,
    hint,
    error,
    width = 'full',
    children,
}: FieldParts & { children: (wiring: Wiring) => ComponentChildren }) {
    const id = useId();
    const noteId = `${id}-note`;
    const wiring: Wiring = {
        id,
        class: `kit-field ${width === 'short' ? 'kit-field-short' : ''}`.trim(),
        'aria-label': labelHidden ? label : undefined,
        'aria-describedby': error || hint ? noteId : undefined,
        'aria-invalid': error ? 'true' : undefined,
    };
    return (
        <div class="kit-field-group">
            {!labelHidden && (
                <label class="kit-field-label" for={id}>
                    {label}
                </label>
            )}
            {children(wiring)}
            {error ? (
                <p class="kit-field-error" id={noteId} role="alert">
                    <Icon name="errorCircle" size={16} />
                    <span>{error}</span>
                </p>
            ) : (
                hint && (
                    <p class="kit-field-hint" id={noteId}>
                        {hint}
                    </p>
                )
            )}
        </div>
    );
}

type Own = 'class' | 'id' | 'label';

/** A one-line input. */
export function TextField({
    label,
    labelHidden,
    hint,
    error,
    width,
    ...input
}: FieldParts & Omit<JSX.InputHTMLAttributes<HTMLInputElement>, Own>) {
    return (
        <FieldGroup label={label} labelHidden={labelHidden} hint={hint} error={error} width={width}>
            {(wiring) => <input type="text" {...input} {...wiring} />}
        </FieldGroup>
    );
}

/** A field for several lines of text. */
export function TextAreaField({
    label,
    labelHidden,
    hint,
    error,
    ...textarea
}: Omit<FieldParts, 'width'> & Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, Own>) {
    return (
        <FieldGroup label={label} labelHidden={labelHidden} hint={hint} error={error}>
            {(wiring) => <textarea {...textarea} {...wiring} />}
        </FieldGroup>
    );
}

export interface SelectOption {
    value: string;
    label: string;
    disabled?: boolean;
}

/** A native select, for a choice among more options than a segmented control holds. */
export function SelectField({
    label,
    labelHidden,
    hint,
    error,
    options,
    ...select
}: Omit<FieldParts, 'width'> & { options: ReadonlyArray<SelectOption> } & Omit<
        JSX.SelectHTMLAttributes<HTMLSelectElement>,
        Own
    >) {
    return (
        <FieldGroup label={label} labelHidden={labelHidden} hint={hint} error={error}>
            {(wiring) => (
                <span class="kit-select">
                    <select {...select} {...wiring}>
                        {options.map((option) => (
                            <option key={option.value} value={option.value} disabled={option.disabled}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                    <Icon name="chevDown" size={16} />
                </span>
            )}
        </FieldGroup>
    );
}
