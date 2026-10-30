import { forwardRef, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, ExternalLink, Laptop, Maximize2, Monitor, RotateCcw, RotateCw, Smartphone, Tablet, Expand,
} from 'lucide-react';

export type Device = 'fill' | 'desktop' | 'laptop' | 'tablet' | 'mobile';
const SIZES: Record<Exclude<Device, 'fill'>, [number, number, string]> = {
  desktop: [1440, 900, 'Desktop'],
  laptop: [1280, 800, 'Laptop'],
  tablet: [820, 1180, 'iPad Air'],
  mobile: [390, 844, 'iPhone 14'],
};

interface Props {
  src: string | null;
  frameKey: number;
  host: string;
  path: string;
  overlay: React.ReactNode;
  toast: React.ReactNode;
  onNavigate(path: string): void;
  onCommand(cmd: 'back' | 'forward' | 'reload'): void;
  onOpenTab(): void;
}

const PreviewPane = forwardRef<HTMLIFrameElement, Props>(function PreviewPane(
  { src, frameKey, host, path, overlay, toast, onNavigate, onCommand, onOpenTab }, ref,
) {
  const [device, setDevice] = useState<Device>('fill');
  const [landscape, setLandscape] = useState(false);
  const [scale, setScale] = useState(1);
  const [draft, setDraft] = useState(path);
  const stage = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(path), [path]);

  const size = device === 'fill' ? null : SIZES[device];
  const w = size ? (landscape ? size[1] : size[0]) : 0;
  const h = size ? (landscape ? size[0] : size[1]) : 0;

  useEffect(() => {
    const el = stage.current;
    if (!el || !size) return;
    const fit = () => {
      const pad = 48;
      setScale(Math.min(1, (el.clientWidth - pad) / w, (el.clientHeight - pad) / h));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [size, w, h]);

  const devices: [Device, React.ReactNode, string][] = [
    ['fill', <Expand size={15} />, 'Fit to panel'],
    ['desktop', <Monitor size={15} />, 'Desktop 1440×900'],
    ['laptop', <Laptop size={15} />, 'Laptop 1280×800'],
    ['tablet', <Tablet size={15} />, 'Tablet 820×1180'],
    ['mobile', <Smartphone size={15} />, 'Mobile 390×844'],
  ];

  return (
    <div className="preview-col" ref={col}>
      <div className="pv-bar">
        <button className="icon-btn hide-sm" title="Back" onClick={() => onCommand('back')}><ArrowLeft size={15} /></button>
        <button className="icon-btn hide-sm" title="Forward" onClick={() => onCommand('forward')}><ArrowRight size={15} /></button>
        <button className="icon-btn" title="Reload" onClick={() => onCommand('reload')}><RotateCw size={15} /></button>
        <form className="url" onSubmit={(e) => { e.preventDefault(); onNavigate(draft.startsWith('/') ? draft : '/' + draft); }}>
          <span className="host">{host}</span>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} aria-label="Preview path" />
        </form>
        <div className="seg hide-sm">
          {devices.map(([d, icon, label]) => (
            <button key={d} className={device === d ? 'on' : ''} title={label} onClick={() => setDevice(d)}>{icon}</button>
          ))}
        </div>
        {size && <button className="icon-btn hide-sm" title="Rotate" onClick={() => setLandscape((l) => !l)}><RotateCcw size={15} /></button>}
        <button className="icon-btn" title="Fullscreen" onClick={() => col.current?.requestFullscreen?.()}><Maximize2 size={15} /></button>
        <button className="icon-btn" title="Open in new tab" onClick={onOpenTab}><ExternalLink size={15} /></button>
      </div>
      <div className={'pv-stage' + (size ? ' framed' : '')} ref={stage}>
        {src && (
          <div className={'device' + (size ? ' framed' : ' fill')} style={size ? { width: w, height: h, transform: `scale(${scale})` } : undefined}>
            <iframe
              key={frameKey}
              ref={ref}
              src={src}
              title="Project preview"
              allow="clipboard-read; clipboard-write; camera; microphone; geolocation; fullscreen; autoplay; display-capture; web-share"
            />
          </div>
        )}
        {size && <div className="device-label">{size[2]} · {w}×{h} · {Math.round(scale * 100)}%</div>}
        {overlay}
        {toast}
      </div>
    </div>
  );
});

export default PreviewPane;
