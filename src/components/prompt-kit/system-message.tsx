import * as React from 'react'
import { AlertTriangle, CircleAlert, Info } from 'lucide-react'

import { Button, type ButtonProps } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type SystemMessageVariant = 'action' | 'warning' | 'error'

type CtaVariant = 'solid' | 'outline' | 'ghost' | NonNullable<ButtonProps['variant']>

interface CTAConfig {
  label: string
  onClick?: () => void
  variant?: CtaVariant
}

interface SystemMessageProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  variant?: SystemMessageVariant
  fill?: boolean
  icon?: React.ReactNode
  isIconHidden?: boolean
  cta?: CTAConfig
}

const iconByVariant: Record<SystemMessageVariant, React.ReactNode> = {
  action: <Info className="size-4" />,
  warning: <AlertTriangle className="size-4" />,
  error: <CircleAlert className="size-4" />,
}

const baseToneByVariant: Record<SystemMessageVariant, string> = {
  action: 'border-border text-foreground',
  warning: 'border-amber-300/60 text-amber-900 dark:border-amber-800 dark:text-amber-200',
  error: 'border-red-300/60 text-red-900 dark:border-red-800 dark:text-red-200',
}

const fillToneByVariant: Record<SystemMessageVariant, string> = {
  action: 'border-transparent bg-muted/70 text-foreground',
  warning: 'border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100',
  error: 'border-transparent bg-red-100 text-red-900 dark:bg-red-950/50 dark:text-red-100',
}

function mapCtaVariant(variant?: CtaVariant): ButtonProps['variant'] {
  if (!variant || variant === 'solid') {
    return 'default'
  }
  return variant as ButtonProps['variant']
}

export function SystemMessage({
  children,
  variant = 'action',
  fill = false,
  icon,
  isIconHidden = false,
  cta,
  className,
  ...props
}: SystemMessageProps) {
  const role = variant === 'error' ? 'alert' : 'status'
  const resolvedIcon = icon ?? iconByVariant[variant]

  return (
    <div
      role={role}
      className={cn(
        'flex items-start justify-between gap-3 rounded-xl border px-3 py-2 text-sm',
        fill ? fillToneByVariant[variant] : baseToneByVariant[variant],
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 items-start gap-2">
        {!isIconHidden ? <span className="mt-0.5 shrink-0">{resolvedIcon}</span> : null}
        <div className="min-w-0 whitespace-pre-wrap break-words">{children}</div>
      </div>

      {cta ? (
        <Button
          type="button"
          size="sm"
          variant={mapCtaVariant(cta.variant)}
          className="shrink-0"
          onClick={cta.onClick}
        >
          {cta.label}
        </Button>
      ) : null}
    </div>
  )
}
