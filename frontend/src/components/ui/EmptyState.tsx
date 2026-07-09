"use client";

import { type ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, secondaryAction, className = "" }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center py-16 px-6 text-center ${className}`}>
      {icon && (
        <div className="mb-5 text-zinc-600">{icon}</div>
      )}
      <h3 className="text-card-title text-zinc-300">{title}</h3>
      {description && (
        <p className="text-secondary mt-1.5 max-w-sm">{description}</p>
      )}
      {action && (
        <div className="mt-6">{action}</div>
      )}
      {secondaryAction && (
        <div className="mt-3">{secondaryAction}</div>
      )}
    </div>
  );
}
