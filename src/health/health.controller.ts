import { Controller, Get, HttpCode } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

@Controller('health')
export class HealthController {
  private readonly trelloKey: string;
  private readonly trelloToken: string;
  private readonly claudeBin: string;

  constructor(private readonly config: ConfigService) {
    this.trelloKey = this.config.getOrThrow<string>('TRELLO_KEY');
    this.trelloToken = this.config.getOrThrow<string>('TRELLO_TOKEN');
    this.claudeBin = this.config.get<string>('CLAUDE_BIN', 'claude');
  }

  @Get()
  @HttpCode(200)
  async check(): Promise<Record<string, unknown>> {
    const [trello, claude] = await Promise.all([
      this.checkTrello(),
      this.checkClaude(),
    ]);

    const healthy = trello.ok && claude.ok;

    return {
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: { trello, claude },
    };
  }

  private async checkTrello(): Promise<{ ok: boolean; message: string }> {
    try {
      const url = `https://api.trello.com/1/members/me?key=${this.trelloKey}&token=${this.trelloToken}&fields=username`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      const data = (await res.json()) as { username?: string };
      return { ok: true, message: `autenticado como @${data.username ?? 'desconhecido'}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  private async checkClaude(): Promise<{ ok: boolean; message: string }> {
    try {
      const { stdout } = await execFileAsync(this.claudeBin, ['--version'], {
        timeout: 5000,
      });
      return { ok: true, message: stdout.trim() };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}
