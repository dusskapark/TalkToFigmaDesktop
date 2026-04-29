import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { HelpCircle, ExternalLink, FileText, Github, BookOpen, MessageCircle, Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function HelpPage() {
    const { t } = useTranslation()
    const [canCheckForUpdates, setCanCheckForUpdates] = useState(false)

    useEffect(() => {
        let active = true

        const loadUpdateCapabilities = async () => {
            try {
                const capabilities = await window.electron?.update?.getCapabilities?.()
                if (active) {
                    setCanCheckForUpdates(capabilities?.canCheckForUpdates ?? false)
                }
            } catch {
                if (active) {
                    setCanCheckForUpdates(false)
                }
            }
        }

        void loadUpdateCapabilities()

        return () => {
            active = false
        }
    }, [])

    const openExternal = (url: string) => {
        window.electron?.shell?.openExternal?.(url)
    }

    const checkForUpdates = () => {
        window.electron?.update?.check?.()
    }

    return (
        <div className="space-y-6 max-w-3xl pb-6">
            {/* Getting Started */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <BookOpen className="size-5" />
                        {t('help.gettingStarted')}
                    </CardTitle>
                    <CardDescription>
                        {t('help.gettingStartedDescription')}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                        {t('help.gettingStartedBody')}
                    </p>
                    <Button
                        variant="default"
                        className="w-full"
                        onClick={async () => {
                            // Reset the hasSeenTutorial flag and reload to show tutorial
                            await window.electron.settings.set('hasSeenTutorial', false)
                            window.location.reload()
                        }}
                    >
                        <BookOpen className="size-4 mr-2" />
                        {t('help.openTutorial')}
                    </Button>
                </CardContent>
            </Card>

            {canCheckForUpdates && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Download className="size-5" />
                            {t('help.updates')}
                        </CardTitle>
                        <CardDescription>
                            {t('help.updatesDescription')}
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <Button
                            variant="outline"
                            className="w-full justify-start"
                            onClick={checkForUpdates}
                        >
                            <Download className="size-4 mr-2" />
                            {t('common.checkForUpdates')}
                        </Button>
                    </CardContent>
                </Card>
            )}

            {/* Get Help */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <MessageCircle className="size-5" />
                        {t('help.getHelp')}
                    </CardTitle>
                    <CardDescription>
                        {t('help.getHelpDescription')}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                    <Button
                        variant="outline"
                        className="w-full justify-start"
                        onClick={() => openExternal('https://github.com/grab/TalkToFigmaDesktop/issues')}
                    >
                        <HelpCircle className="size-4 mr-2" />
                        {t('common.reportIssue')}
                        <ExternalLink className="size-3 ml-auto" />
                    </Button>
                </CardContent>
            </Card>

            {/* Resources */}
            <Card>
                <CardHeader>
                    <CardTitle>{t('help.resources')}</CardTitle>
                    <CardDescription>{t('help.resourcesDescription')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                    <Button
                        variant="outline"
                        className="w-full justify-start"
                        onClick={() => openExternal('https://github.com/grab/TalkToFigmaDesktop')}
                    >
                        <Github className="size-4 mr-2" />
                        {t('help.githubRepository')}
                        <ExternalLink className="size-3 ml-auto" />
                    </Button>
                    <Button
                        variant="outline"
                        className="w-full justify-start"
                        onClick={() => openExternal('https://modelcontextprotocol.io')}
                    >
                        <FileText className="size-4 mr-2" />
                        {t('help.mcpProtocolDocs')}
                        <ExternalLink className="size-3 ml-auto" />
                    </Button>
                    <Button
                        variant="outline"
                        className="w-full justify-start"
                        onClick={() => openExternal('https://www.figma.com/plugin-docs/')}
                    >
                        <FileText className="size-4 mr-2" />
                        {t('help.figmaPluginApiDocs')}
                        <ExternalLink className="size-3 ml-auto" />
                    </Button>
                </CardContent>
            </Card>
        </div>
    )
}
