import * as React from 'react'

import { cn } from '@/lib/utils'

interface PromptInputContextValue {
  value: string
  onValueChange: (value: string) => void
  onSubmit: () => void
  disabled?: boolean
  maxHeight: number
}

const PromptInputContext = React.createContext<PromptInputContextValue | null>(null)

function usePromptInputContext(): PromptInputContextValue {
  const context = React.useContext(PromptInputContext)
  if (!context) {
    throw new Error('PromptInput components must be used inside <PromptInput>')
  }
  return context
}

interface PromptInputProps extends Omit<React.FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> {
  value: string
  onValueChange: (value: string) => void
  onSubmit: () => void
  isLoading?: boolean
  disabled?: boolean
  maxHeight?: number
}

export function PromptInput({
  value,
  onValueChange,
  onSubmit,
  isLoading,
  disabled,
  maxHeight = 220,
  className,
  children,
  ...props
}: PromptInputProps) {
  const isDisabled = Boolean(disabled)

  return (
    <PromptInputContext.Provider
      value={{
        value,
        onValueChange,
        onSubmit,
        disabled: isDisabled,
        maxHeight,
      }}
    >
      <form
        className={cn('rounded-2xl border border-input bg-background p-2 shadow-xs', className)}
        onSubmit={(event) => {
          event.preventDefault()
          if (!isDisabled && !isLoading) {
            onSubmit()
          }
        }}
        {...props}
      >
        {children}
      </form>
    </PromptInputContext.Provider>
  )
}

interface PromptInputTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  disableAutosize?: boolean
}

export function PromptInputTextarea({ className, disableAutosize = false, onKeyDown, ...props }: PromptInputTextareaProps) {
  const { value, onValueChange, onSubmit, disabled, maxHeight } = usePromptInputContext()
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const isComposingRef = React.useRef(false)

  React.useLayoutEffect(() => {
    if (disableAutosize) return
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`
  }, [value, disableAutosize, maxHeight])

  return (
    <textarea
      ref={textareaRef}
      rows={1}
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented) return
        if (event.key === 'Enter' && !event.shiftKey) {
          const nativeEvent = event.nativeEvent as KeyboardEvent
          const isComposing = isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229
          if (isComposing) {
            return
          }
          event.preventDefault()
          if (!disabled && value.trim()) {
            onSubmit()
          }
        }
      }}
      onCompositionStart={(event) => {
        isComposingRef.current = true
        props.onCompositionStart?.(event)
      }}
      onCompositionEnd={(event) => {
        isComposingRef.current = false
        props.onCompositionEnd?.(event)
      }}
      className={cn(
        'w-full min-h-[44px] resize-none border-none bg-transparent px-2 py-2 text-sm leading-6 outline-none',
        'placeholder:text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export function PromptInputActions({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center justify-between gap-2 px-1 pb-1', className)} {...props} />
}

interface PromptInputActionProps extends React.HTMLAttributes<HTMLDivElement> {
  tooltip?: React.ReactNode
}

export function PromptInputAction({ className, tooltip, children, ...props }: PromptInputActionProps) {
  return (
    <div className={cn('flex items-center', className)} title={typeof tooltip === 'string' ? tooltip : undefined} {...props}>
      {children}
    </div>
  )
}
