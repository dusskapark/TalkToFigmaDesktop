import * as React from 'react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Markdown } from '@/components/prompt-kit/markdown'

interface MessageProps extends React.HTMLAttributes<HTMLDivElement> {
  from?: 'user' | 'assistant' | 'system'
}

export function Message({ className, from = 'assistant', ...props }: MessageProps) {
  return (
    <div
      className={cn('flex w-full items-start gap-3', from === 'user' ? 'justify-end' : 'justify-start', className)}
      {...props}
    />
  )
}

interface MessageAvatarProps {
  src?: string
  alt?: string
  fallback?: string
  className?: string
}

export function MessageAvatar({ src, alt, fallback = 'AI', className }: MessageAvatarProps) {
  return (
    <Avatar className={cn('size-7 border border-border', className)}>
      {src ? <AvatarImage src={src} alt={alt ?? fallback} /> : null}
      <AvatarFallback className="text-[11px]">{fallback}</AvatarFallback>
    </Avatar>
  )
}

interface MessageContentProps extends React.HTMLAttributes<HTMLDivElement> {
  markdown?: boolean
  from?: 'user' | 'assistant' | 'system'
  children: string
}

export function MessageContent({
  children,
  className,
  markdown = false,
  from = 'assistant',
  ...props
}: MessageContentProps) {
  const isUser = from === 'user'

  const content = String(children)

  return (
    <div
      className={cn(
        'rounded-2xl border px-4 py-3 text-sm',
        isUser ? 'w-fit max-w-[85%] sm:max-w-[75%]' : 'w-full',
        isUser
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-card text-card-foreground',
        className,
      )}
      {...props}
    >
      {markdown && !isUser ? (
        <Markdown>{content}</Markdown>
      ) : (
        <p className="whitespace-pre-wrap break-words">{content}</p>
      )}
    </div>
  )
}

type MessageActionsProps = React.HTMLAttributes<HTMLDivElement>

export function MessageActions({ className, ...props }: MessageActionsProps) {
  return <div className={cn('flex items-center gap-0.5 text-muted-foreground', className)} {...props} />
}

interface MessageActionProps {
  tooltip: React.ReactNode
  children: React.ReactElement
}

export function MessageAction({ tooltip, children }: MessageActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent sideOffset={6}>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
