import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';

const SignaturePad = forwardRef(function SignaturePad({ disabled = false }, ref) {
    const canvasRef = useRef(null);
    const drawingRef = useRef(false);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;

        const context = canvas.getContext('2d');
        context.strokeStyle = '#132500';
        context.lineWidth = 2;
        context.lineCap = 'round';

        const point = (event) => {
            const rect = canvas.getBoundingClientRect();
            const p = event.touches ? event.touches[0] : event;
            return {
                x: (p.clientX - rect.left) * (canvas.width / rect.width),
                y: (p.clientY - rect.top) * (canvas.height / rect.height),
            };
        };

        const start = (event) => {
            if (disabled) return;
            drawingRef.current = true;
            const p = point(event);
            context.beginPath();
            context.moveTo(p.x, p.y);
            event.preventDefault();
        };

        const draw = (event) => {
            if (!drawingRef.current || disabled) return;
            const p = point(event);
            context.lineTo(p.x, p.y);
            context.stroke();
            canvas.dataset.signed = 'yes';
            event.preventDefault();
        };

        const stop = () => { drawingRef.current = false; };

        canvas.addEventListener('mousedown', start);
        canvas.addEventListener('mousemove', draw);
        canvas.addEventListener('mouseup', stop);
        canvas.addEventListener('mouseleave', stop);
        canvas.addEventListener('touchstart', start, { passive: false });
        canvas.addEventListener('touchmove', draw, { passive: false });
        canvas.addEventListener('touchend', stop);
        canvas.addEventListener('touchcancel', stop);

        return () => {
            canvas.removeEventListener('mousedown', start);
            canvas.removeEventListener('mousemove', draw);
            canvas.removeEventListener('mouseup', stop);
            canvas.removeEventListener('mouseleave', stop);
            canvas.removeEventListener('touchstart', start);
            canvas.removeEventListener('touchmove', draw);
            canvas.removeEventListener('touchend', stop);
            canvas.removeEventListener('touchcancel', stop);
        };
    }, [disabled]);

    useImperativeHandle(ref, () => ({
        clear() {
            const canvas = canvasRef.current;
            if (!canvas) return;
            canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
            delete canvas.dataset.signed;
        },
        toDataUrl() {
            const canvas = canvasRef.current;
            if (!canvas || canvas.dataset.signed !== 'yes') return null;
            return canvas.toDataURL('image/png');
        },
        isSigned() {
            return canvasRef.current?.dataset.signed === 'yes';
        },
    }), []);

    return (
        <canvas
            ref={canvasRef}
            className="signature-pad"
            width={600}
            height={220}
            aria-label="Signature pad"
        />
    );
});

export default SignaturePad;
