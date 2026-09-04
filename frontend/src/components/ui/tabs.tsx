"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;
const TabsList = React.forwardRef<React.ElementRef<typeof TabsPrimitive.List>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(({ className, ...props }, ref) => <TabsPrimitive.List ref={ref} className={cn("inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-1", className)} {...props} />);
TabsList.displayName = TabsPrimitive.List.displayName;
const TabsTrigger = React.forwardRef<React.ElementRef<typeof TabsPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(({ className, ...props }, ref) => <TabsPrimitive.Trigger ref={ref} className={cn("inline-flex min-h-9 items-center justify-center rounded-md px-3 text-xs font-semibold text-[var(--zone-light-text-secondary)] transition-colors hover:text-[var(--brand-green)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-green-soft)] data-[state=active]:bg-[var(--brand-green)] data-[state=active]:text-[var(--brand-on-green)]", className)} {...props} />);
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;
const TabsContent = React.forwardRef<React.ElementRef<typeof TabsPrimitive.Content>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(({ className, ...props }, ref) => <TabsPrimitive.Content ref={ref} className={cn("mt-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--signal-lime)]", className)} {...props} />);
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
