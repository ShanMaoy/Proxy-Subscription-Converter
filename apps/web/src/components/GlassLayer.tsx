import { Glass, type GlassOptics } from "@samasante/liquid-glass";

const optics: Partial<GlassOptics> = {
  mapSize: 128,
  strength: 0.055,
  depth: 0.42,
  curvature: 0.17,
  bend: 0.48,
  bendWidth: 0.12,
  dispersion: 0.14,
  frost: 9,
  saturate: 1.35,
  specular: 1.15,
  brightness: 0,
};

export function GlassLayer() {
  return (
    <Glass aria-hidden="true" className="glass-optics" optics={optics}>
      <span />
    </Glass>
  );
}
