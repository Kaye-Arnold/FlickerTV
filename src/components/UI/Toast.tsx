'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastMessage {
  id:        string;
  message:   string;
  variant:   ToastVariant;
  durationMs:number;
  icon?:     string;
}

interface ToastContextValue {
  show: (
    message: string,
    variant?: ToastVariant,
    options?: { durationMs?: number; icon?: string }
  ) => void;
  dismiss: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const counterRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (
      message: string,
      variant: ToastVariant = 'info',
      options: { durationMs?: number; icon?: string } = {}
    ) => {
      const id = `toast-${Date.now()}-${counterRef.current++}`;
      const durationMs = options.durationMs ?? 3200;

      const toast: ToastMessage = {
        id,
        message,
        variant,
        durationMs,
        icon: options.icon,
      };

      setToasts((prev) => [...prev.slice(-3), toast]); // max 4 toasts at once

      setTimeout(() => dismiss(id), durationMs);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ show, dismiss }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Individual toast
// ---------------------------------------------------------------------------

const VARIANT_STYLES: Record<
  ToastVariant,
  { border: string; iconDefault: string }
> = {
  info:    { border: 'rgba(200,169,110,0.3)', iconDefault: '🎬' },
  success: { border: 'rgba(74,222,128,0.3)',  iconDefault: '✓'  },
  warning: { border: 'rgba(251,191,36,0.3)',  iconDefault: '⚠'  },
  error:   { border: 'rgba(248,113,113,0.3)', iconDefault: '✕'  },
};

const VARIANT_ICON_COLOR: Record<ToastVariant, string> = {
  info:    '#c8a96e',
  success: '#4ade80',
  warning: '#fbbf24',
  error:   '#f87171',
};

const Toast: React.FC<{
  toast: ToastMessage;
  onDismiss: (id: string) => void;
}> = ({ toast, onDismiss }) => {
  const variantStyle = VARIANT_STYLES[toast.variant];
  const icon         = toast.icon ?? variantStyle.iconDefault;
  const iconColor    = VARIANT_ICON_COLOR[toast.variant];

  return (
    <motion.div
      layout
      key={toast.id}
      className="toast"
      style={{ borderColor: variantStyle.border }}
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0,  scale: 1    }}
      exit={{    opacity: 0, y: -8, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 420, damping: 36 }}
    >
      <span
        className="toast__icon"
        style={{ color: iconColor }}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="toast__message">{toast.message}</span>
      <button
        className="toast__dismiss"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        ✕
      </button>

      {/* Auto-dismiss progress bar */}
      <motion.div
        className="toast__progress"
        style={{ backgroundColor: iconColor }}
        initial={{ scaleX: 1 }}
        animate={{ scaleX: 0 }}
        transition={{
          duration: toast.durationMs / 1000,
          ease: 'linear',
        }}
      />
    </motion.div>
  );
};

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

const ToastContainer: React.FC<{
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}> = ({ toasts, onDismiss }) => (
  <>
    <style>{TOAST_STYLES}</style>
    <div
      className="toast-container"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>
  </>
);

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const TOAST_STYLES = `
  .toast-container {
    position: fixed;
    bottom: calc(80px + env(safe-area-inset-bottom, 0px));
    left: 50%;
    transform: translateX(-50%);
    z-index: 9000;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    pointer-events: none;
    width: min(380px, calc(100vw - 32px));
  }

  .toast {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 13px 14px;
    background: rgba(10, 10, 22, 0.94);
    border: 1px solid;
    border-radius: 14px;
    backdrop-filter: blur(16px) saturate(1.5);
    -webkit-backdrop-filter: blur(16px) saturate(1.5);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    pointer-events: auto;
    position: relative;
    overflow: hidden;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  .toast__icon {
    font-size: 16px;
    flex-shrink: 0;
    line-height: 1;
  }

  .toast__message {
    flex: 1;
    font-size: 13px;
    font-weight: 500;
    color: rgba(255,255,255,0.88);
    line-height: 1.4;
    min-width: 0;
  }

  .toast__dismiss {
    background: none;
    border: none;
    color: rgba(255,255,255,0.35);
    cursor: pointer;
    font-size: 11px;
    flex-shrink: 0;
    padding: 2px 4px;
    transition: color 0.15s ease;
    line-height: 1;
  }

  .toast__dismiss:hover {
    color: rgba(255,255,255,0.7);
  }

  .toast__progress {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 2px;
    transform-origin: left center;
    opacity: 0.55;
  }
`;