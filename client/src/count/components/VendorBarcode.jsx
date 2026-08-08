import { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';

/**
 * Code128 barcode for a vendor / shelf item number (relay-scannable).
 */
export default function VendorBarcode({
    value,
    height = 56,
    displayValue = true,
    className = '',
    background = '#ffffff',
    lineColor = '#000000',
}) {
    const svgRef = useRef(null);
    const text = String(value || '').trim();

    useEffect(() => {
        const el = svgRef.current;
        if (!el || !text) return;
        try {
            JsBarcode(el, text, {
                format: 'CODE128',
                displayValue,
                fontSize: 14,
                height,
                margin: 4,
                background,
                lineColor,
                textMargin: 4,
            });
        } catch (_) {
            el.replaceChildren();
        }
    }, [text, height, displayValue, background, lineColor]);

    if (!text) return null;
    return <svg ref={svgRef} className={className} role="img" aria-label={`Barcode ${text}`} />;
}
