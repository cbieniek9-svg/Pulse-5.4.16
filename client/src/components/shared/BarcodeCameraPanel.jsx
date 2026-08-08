import { useId } from 'react';
import '../../styles/barcode-camera.css';

/**
 * Live-camera + snap-photo barcode capture, shared by the Count and Markdown portals.
 * Pass the object returned by useBarcodeCamera.
 *
 * Optional `typeMode` / `onToggleTypeMode` draw a TYPE CODE button beside the camera
 * controls so keyboard entry is one tap away when the soft keyboard is locked off.
 */
export default function BarcodeCameraPanel({
    camera,
    status,
    buttonClass = 'btn btn-sm',
    label = 'LIVE CAMERA',
    typeMode = false,
    onToggleTypeMode = null,
    typeModeLabel = 'TYPE CODE',
    scanModeLabel = 'SCAN MODE',
}) {
    const readerId = useId().replace(/:/g, '');
    const snapReaderId = useId().replace(/:/g, '');
    const snapInputId = `cam-snap-${snapReaderId}`;

    const handleSnapChange = async (ev) => {
        const file = ev.target.files?.[0];
        ev.target.value = '';
        if (file) await camera.onSnapBarcode(file);
    };

    const statusClass = status?.ok === true ? 'ok' : status?.ok === false ? 'err' : '';

    return (
        <div>
            <div className="tgp-cam-toolbar">
                <button type="button" className={buttonClass} onClick={camera.toggleCamera}>
                    {camera.cameraOn ? 'STOP CAMERA' : label}
                </button>
                <label className={buttonClass} htmlFor={snapInputId} style={{ margin: 0, display: 'inline-block' }}>
                    SNAP BARCODE
                </label>
                <input
                    id={snapInputId}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    style={{ display: 'none' }}
                    onChange={handleSnapChange}
                />
                {typeof onToggleTypeMode === 'function' ? (
                    <button type="button" className={`${buttonClass} btn-secondary`} onClick={onToggleTypeMode}>
                        {typeMode ? scanModeLabel : typeModeLabel}
                    </button>
                ) : null}
            </div>

            {camera.httpsHintHtml ? (
                <p className="tgp-cam-hint" dangerouslySetInnerHTML={{ __html: camera.httpsHintHtml }} />
            ) : null}

            <div
                className={`tgp-cam-panel ${camera.scanFlash ? 'scan-flash' : ''}`}
                style={camera.panelVisible ? undefined : { display: 'none' }}
            >
                <div
                    ref={(el) => {
                        camera.scannerRef.current = el;
                        if (el && !el.id) el.id = `tgp-cam-reader-${readerId}`;
                    }}
                    className="tgp-cam-reader"
                />
            </div>

            <div
                ref={(el) => {
                    camera.snapReaderRef.current = el;
                    if (el && !el.id) el.id = `tgp-cam-snap-${snapReaderId}`;
                }}
                className="tgp-cam-snap-reader"
                aria-hidden="true"
            />

            {status?.msg ? <p className={`tgp-cam-status ${statusClass}`} aria-live="polite">{status.msg}</p> : null}
        </div>
    );
}
