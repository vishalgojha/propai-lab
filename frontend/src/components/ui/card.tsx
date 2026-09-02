import * as React from "react";
import { cn } from "@/lib/utils";

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => <div ref={ref} className={cn("propai-card border border-[var(--zone-light-border)] bg-[var(--zone-light-card)] text-[var(--zone-light-text-primary)]", className)} {...props} />);
Card.displayName = "Card";
const CardHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("flex flex-col space-y-1.5 p-4", className)} {...props} />;
const CardTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h3 className={cn("font-semibold leading-none tracking-tight", className)} {...props} />;
const CardContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("p-4 pt-0", className)} {...props} />;
const CardFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("flex items-center p-4 pt-0", className)} {...props} />;
export { Card, CardHeader, CardTitle, CardContent, CardFooter };
