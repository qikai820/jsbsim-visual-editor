import type { ComponentType } from '../types';

const paths: Record<ComponentType, string> = {
  fuselage: 'M12 2l2 7 6 3v2l-6-1-1 8h-2l-1-8-6 1v-2l6-3 2-7z',
  wing: 'M3 11l18-5-3 5 3 5-18-5z',
  htail: 'M4 10l16-3-2 4 2 4-16-3z',
  vtail: 'M9 20l3-17 4 14-3 3z',
  engine: 'M6 5h10l3 4v6l-3 4H6l-3-4V9z M8 8v8h6V8z',
  propeller: 'M12 10c-4-7-7-6-6-3 1 3 3 5 5 6-7 4-6 7-3 6 3-1 5-3 6-5 4 7 7 6 6 3-1-3-3-5-5-6 7-4 6-7 3-6-3 1-5 3-6 5z',
  landing_gear: 'M7 3h10v7h-4v5m-2-5v5M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6m12 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  fuel_tank: 'M7 3h10v3l2 3v11H5V9l2-3z M9 8h6',
  point_mass: 'M12 3v5m-6 3h12M8 11l-4 8h8zm8 0l-4 8h8z',
  inertia: 'M12 4a8 8 0 1 0 8 8M12 4l3 3m-3-3L9 7M4 12h4m8 0h4',
  aero_coefficients: 'M3 17c5-8 9-10 18-10-5 2-8 5-10 10-3 3-5 2-8 0z',
  environment: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18',
  system: 'M8 7h8v4H8z M4 15h6v4H4zm10 0h6v4h-6z M12 11v4M7 15v-2h10v2',
  flight_control: 'M4 6h16M7 6v5m10-5v9M4 11h6m4 4h6M7 15v4m10-8v8',
  input: 'M3 5h10v4h8v6h-8v4H3z M8 9v6m-3-3h6',
  output: 'M3 5h10v4h8v6h-8v4H3z M16 9l4 3-4 3',
  uavcan: 'M5 5h14v14H5z M8 9h8M8 12h8M8 15h5 M3 8h2m14 0h2M3 16h2m14 0h2',
};

export default function AviationIcon({ type, size = 18 }: { type: ComponentType; size?: number }) {
  return <svg className="aviation-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path d={paths[type]} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

