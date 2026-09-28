import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiTags } from "@nestjs/swagger";
import { AppConfig } from "../config/configuration";
import { DatabaseHealthService } from "./database-health.service";
import { ContractVersionService } from "../soroban/contract-version.service";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly dbHealth: DatabaseHealthService,
    private readonly contractVersions: ContractVersionService,
  ) {}

  @Get("live")
  live() {
    return {
      status: "ok",
      service: "vortex-backend",
      version: "0.1.0",
      network: `stellar-${this.configService.get("stellar.network", { infer: true })}`,
      uptime: process.uptime(),
    };
  }

  @Get("ready")
  async ready() {
    const db = await this.dbHealth.check();

    return {
      status: db.status === "ok" ? "ok" : "unreachable",
      service: "vortex-backend",
      version: "0.1.0",
      network: `stellar-${this.configService.get("stellar.network", { infer: true })}`,
      uptime: process.uptime(),
      db,
      // Issue #402: read-only when a configured contract's WASM hash is not
      // on a supported ABI. Reads keep working, so this does not fail the probe.
      ...this.contractVersions.snapshot(),
    };
  }

  @Get()
  async check() {
    const db = await this.dbHealth.check();

    return {
      status: "ok",
      service: "vortex-backend",
      version: "0.1.0",
      network: `stellar-${this.configService.get("stellar.network", { infer: true })}`,
      uptime: process.uptime(),
      db,
      // Issue #402: read-only when a configured contract's WASM hash is not
      // on a supported ABI. Reads keep working, so this does not fail the probe.
      ...this.contractVersions.snapshot(),
    };
  }
}
