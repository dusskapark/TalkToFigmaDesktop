/*
 * Copyright 2026 Grabtaxi Holdings Pte Ltd (GRAB), All rights reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be found in the LICENSE file
 */

import { BrowserWindow, protocol } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

const RENDERER_PROTOCOL = 'talktofigma-renderer';

interface LoggerLike {
  info: (message: string) => void;
  error: (message: string, error?: unknown) => void;
}

interface RendererLoaderOptions {
  devServerUrl?: string;
  rendererName: string;
  logger: LoggerLike;
}

let rendererProtocolRegistered = false;

export function registerRendererProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

export function getRendererRoot(rendererName: string): string {
  return path.join(__dirname, `../renderer/${rendererName}`);
}

export function getPackagedRendererUrl(): string {
  return `${RENDERER_PROTOCOL}://renderer/index.html`;
}

export function registerRendererProtocol({ devServerUrl, rendererName, logger }: RendererLoaderOptions): void {
  if (devServerUrl || rendererProtocolRegistered) {
    return;
  }

  const rendererRoot = getRendererRoot(rendererName);

  protocol.handle(RENDERER_PROTOCOL, async (request) => {
    const requestUrl = new URL(request.url);
    const requestedPath = decodeURIComponent(requestUrl.pathname);
    const relativePath = requestedPath === '/' || requestedPath === ''
      ? 'index.html'
      : requestedPath.replace(/^\/+/, '');
    const filePath = path.join(rendererRoot, relativePath);
    const relativeToRoot = path.relative(rendererRoot, filePath);

    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      return new Response('Not found', { status: 404 });
    }

    try {
      const file = await fs.readFile(filePath);
      return new Response(file, {
        headers: {
          'content-type': getContentType(filePath),
        },
      });
    } catch (error) {
      logger.error(`Renderer asset not found: ${filePath}`, error);
      return new Response('Not found', { status: 404 });
    }
  });

  rendererProtocolRegistered = true;
  logger.info(`Renderer protocol registered for: ${rendererRoot}`);
}

export function loadRenderer(window: BrowserWindow, { devServerUrl, logger }: RendererLoaderOptions): Promise<void> {
  const rendererUrl = devServerUrl || getPackagedRendererUrl();
  logger.info(`Loading renderer: ${rendererUrl}`);
  return window.loadURL(rendererUrl);
}

function getContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml';
    case '.ico':
      return 'image/x-icon';
    case '.icns':
      return 'image/icns';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}
