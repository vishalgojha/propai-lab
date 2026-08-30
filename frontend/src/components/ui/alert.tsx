import * as React from "react";
import { cn } from "@/lib/utils";

const Alert = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => <div ref={ref} role="alert" className={cn("relative w-full rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-3 text-sm text-[var(--text-secondary)]", className)} {...props} />);
Alert.displayName = "Alert";
const AlertTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h5 className={cn("mb-1 font-medium leading-none tracking-tight text-[var(--text-primary)]", className)} {...props} />;
const AlertDescription = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("text-xs leading-5", className)} {...props} />;
export { Alert, AlertTitle, AlertDescription };
