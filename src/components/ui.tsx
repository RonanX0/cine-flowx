import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as LabelPrimitive from "@radix-ui/react-label";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import * as SliderPrimitive from "@radix-ui/react-slider";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { X } from "lucide-react";

export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "brand";
type ButtonSize = "default" | "sm" | "lg" | "icon";

const buttonVariants: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  outline: "border border-border bg-transparent hover:bg-muted/60",
  ghost: "hover:bg-muted/60",
  brand: "bg-brand text-primary-foreground hover:bg-brand/90",
};
const buttonSizes: Record<ButtonSize, string> = {
  default: "h-9 px-4 py-2",
  sm: "h-8 rounded-md px-3 text-xs",
  lg: "h-10 rounded-md px-6",
  icon: "h-9 w-9",
};

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }
>(({ className, variant = "default", size = "default", ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-50",
      buttonVariants[variant],
      buttonSizes[size],
      className
    )}
    {...props}
  />
));
Button.displayName = "Button";

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: "default" | "secondary" | "outline" | "success" | "destructive" }) {
  const styles = {
    default: "bg-primary text-primary-foreground",
    secondary: "bg-secondary text-secondary-foreground",
    outline: "border border-border text-foreground",
    success: "bg-success text-background",
    destructive: "bg-destructive text-destructive-foreground",
  }[variant];
  return (
    <span
      className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium", styles, className)}
      {...props}
    />
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-border bg-muted/30 px-3 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "flex h-9 w-full cursor-pointer rounded-md border border-border bg-muted/30 px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-ring",
        className
      )}
      {...props}
    />
  )
);
Select.displayName = "Select";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring",
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";

export const Label = ({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) => (
  <LabelPrimitive.Root className={cn("text-xs font-medium text-muted-foreground", className)} {...props} />
);

export const Switch = ({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) => (
  <SwitchPrimitive.Root
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted",
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="block h-4 w-4 rounded-full bg-white transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitive.Root>
);

export const Slider = ({ className, ...props }: React.ComponentProps<typeof SliderPrimitive.Root>) => (
  <SliderPrimitive.Root className={cn("relative flex w-full touch-none select-none items-center", className)} {...props}>
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border-2 border-primary bg-background cursor-pointer" />
  </SliderPrimitive.Root>
);

export const Progress = ({ className, ...props }: React.ComponentProps<typeof ProgressPrimitive.Root>) => (
  <ProgressPrimitive.Root className={cn("relative h-2 w-full overflow-hidden rounded-full bg-muted", className)} {...props}>
    <ProgressPrimitive.Indicator className="h-full w-full flex-1 bg-primary transition-transform" />
  </ProgressPrimitive.Root>
);

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm" />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-border bg-card p-6 shadow-lg rounded-xl max-h-[90vh] overflow-y-auto",
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 cursor-pointer">
          <X className="h-4 w-4" />
          <span className="sr-only">Fechar</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const DialogTitle = ({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) => (
  <DialogPrimitive.Title className={cn("text-lg font-semibold", className)} {...props} />
);

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-border bg-card p-5", className)} {...props} />;
}
