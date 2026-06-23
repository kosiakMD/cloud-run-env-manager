import { serviceLabel, type ServiceConfig, type ServiceId } from '../../shared/config.js';

interface Props {
  services: ServiceConfig[];
  active: ServiceId;
  onChange: (id: ServiceId) => void;
}

export function ServiceTabs({ services, active, onChange }: Props) {
  return (
    <div className="flex gap-1">
      {services.map((s) => (
        <button
          key={s.id}
          onClick={() => onChange(s.id)}
          className={`h-7 inline-flex items-center px-2 rounded text-xs font-medium ${
            active === s.id
              ? 'bg-slate-200 text-slate-900 ring-1 ring-slate-400 font-semibold dark:bg-slate-200 dark:text-slate-900'
              : 'bg-slate-100 hover:bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
          }`}
          title={s.id}
        >
          {serviceLabel(s)}
        </button>
      ))}
    </div>
  );
}
