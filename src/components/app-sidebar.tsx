"use client"

import * as React from "react"
import {
  Bot,
  Terminal,
  Settings,
  HelpCircle,
  type LucideIcon,
} from "lucide-react"

import { NavUser } from "@/components/nav-user"
import { ServerControls, ServerStatus } from "@/components/server-controls"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  useSidebar,
} from "@/components/ui/sidebar"
import { useTranslation } from "react-i18next"

// Logo images from public directory (reusing tray icons)
const logoDark = "tray_dark.png"
const logoLight = "trayTemplate.png"

// Navigation items
type NavItem = {
  id: 'assistant' | 'terminal' | 'settings' | 'help'
  title: string
  icon: LucideIcon
}

export type PageId = NavItem['id']

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  currentPage: PageId
  onPageChange: (page: PageId) => void
  serverStatus: ServerStatus & { error?: string | null }
  figmaUser: {
    name: string
    email: string
    avatar?: string
  } | null
  onStartAll: () => void
  onStopAll: () => void
  onRestartAll?: () => void
  onFigmaLogin: () => void
  onFigmaLogout: () => void
}

export function AppSidebar({
  currentPage,
  onPageChange,
  serverStatus,
  figmaUser,
  onStartAll,
  onStopAll,
  onRestartAll,
  onFigmaLogin,
  onFigmaLogout,
  ...props
}: AppSidebarProps) {
  const { t } = useTranslation()
  const { state } = useSidebar()
  const isCollapsed = state === "collapsed"
  const navItems: readonly NavItem[] = [
    { id: 'assistant', title: t('app.nav.assistant'), icon: Bot },
    { id: 'terminal', title: t('app.nav.terminal'), icon: Terminal },
    { id: 'settings', title: t('app.nav.settings'), icon: Settings },
    { id: 'help', title: t('app.nav.help'), icon: HelpCircle },
  ]

  return (
    <Sidebar variant="inset" collapsible="icon" {...props}>
      <SidebarHeader>
        {/* App Logo & Title */}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <div className="cursor-default">
                <div className="flex items-center justify-center shrink-0">
                  <img
                    src={logoLight}
                    alt="TalkToFigma"
                    className="h-8 w-auto object-contain dark:hidden"
                  />
                  <img
                    src={logoDark}
                    alt="TalkToFigma"
                    className="h-8 w-auto object-contain hidden dark:block"
                  />
                </div>
                {!isCollapsed && (
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">TalkToFigma</span>
                    <span className="truncate text-xs text-muted-foreground">{t('app.brand.bridge')}</span>
                  </div>
                )}
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        {/* <SidebarSeparator className="my-2" /> */}

        {/* Server Controls - Responsive to sidebar state */}
        <ServerControls
          status={serverStatus}
          onStart={onStartAll}
          onStop={onStopAll}
          onRestart={onRestartAll}
          variant={isCollapsed ? "mini" : "full"}
          direction={isCollapsed ? "vertical" : "horizontal"}
          error={serverStatus.error}
        />
      </SidebarHeader>

      <SidebarContent>
        {/* Navigation */}
        <SidebarGroup>
          {!isCollapsed && <SidebarGroupLabel>{t('accessibility.sidebar')}</SidebarGroupLabel>}
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={currentPage === item.id}
                    onClick={() => onPageChange(item.id)}
                    tooltip={item.title}
                  >
                    <item.icon className="size-4" />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        {/* User Profile (Figma) - handles login/logout via dropdown */}
        <NavUser
          user={figmaUser ? {
            name: figmaUser.name,
            email: figmaUser.email,
            avatar: figmaUser.avatar || '',
          } : {
            name: t('user.disconnected'),
            email: t('user.clickToConnectFigma'),
            avatar: '',
          }}
          onLogin={onFigmaLogin}
          onLogout={onFigmaLogout}
        />
      </SidebarFooter>
    </Sidebar>
  )
}
