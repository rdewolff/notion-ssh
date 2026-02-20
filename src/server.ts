import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Server } from 'ssh2';

import { env } from './config/env';
import { logger } from './logger';
import { NotionGateway } from './notion/gateway';
import { ShellSession } from './session/shell';
import { VirtualFs } from './vfs';

function ensureHostKey(hostKeyPath: string): Buffer {
  const absolutePath = path.isAbsolute(hostKeyPath)
    ? hostKeyPath
    : path.resolve(process.cwd(), hostKeyPath);

  if (fs.existsSync(absolutePath)) {
    return fs.readFileSync(absolutePath);
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    privateKeyEncoding: {
      type: 'pkcs1',
      format: 'pem'
    },
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    }
  });

  fs.writeFileSync(absolutePath, privateKey, { mode: 0o600 });
  logger.info({ hostKeyPath: absolutePath }, 'Generated SSH host key');
  return Buffer.from(privateKey);
}

async function main(): Promise<void> {
  const hostKey = ensureHostKey(env.SSH_HOST_KEY_PATH);
  const notion = new NotionGateway(env.NOTION_API_KEY);
  const vfs = new VirtualFs(notion, env.CACHE_TTL_SECONDS, env.NOTION_ROOT_PAGE_ID);

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') {
        ctx.reject(['password']);
        return;
      }

      if (env.SSH_ALLOW_ANY_PASSWORD) {
        ctx.accept();
        return;
      }

      const valid = ctx.username === env.SSH_USERNAME && ctx.password === env.SSH_PASSWORD;
      if (valid) {
        ctx.accept();
      } else {
        ctx.reject(['password']);
      }
    });

    client.on('ready', () => {
      logger.info('SSH client connected');
      client.on('session', (accept) => {
        const session = accept();

        session.on('pty', (acceptPty) => {
          acceptPty();
        });

        session.on('shell', (acceptShell) => {
          const channel = acceptShell();
          const shell = new ShellSession(channel, vfs, logger.child({ session: 'interactive-shell' }));
          void shell.start();
        });

        session.on('exec', (acceptExec, _rejectExec, info) => {
          const channel = acceptExec();
          const shell = new ShellSession(channel, vfs, logger.child({ session: 'exec' }));

          void shell
            .runOneCommand(info.command)
            .then(() => {
              channel.end();
            })
            .catch((error) => {
              channel.stderr.write(`error: ${(error as Error).message}\n`);
              channel.exit(1);
              channel.end();
            });
        });
      });
    });

    client.on('error', (error) => {
      logger.warn({ err: error }, 'SSH client error');
    });
  });

  server.on('error', (error: unknown) => {
    logger.error({ err: error }, 'SSH server error');
    process.exitCode = 1;
  });

  server.listen(env.SSH_PORT, env.SSH_HOST, () => {
    logger.info(
      {
        host: env.SSH_HOST,
        port: env.SSH_PORT,
        rootPageId: env.NOTION_ROOT_PAGE_ID ?? null
      },
      'Notion SSH server started'
    );
  });
}

void main();
