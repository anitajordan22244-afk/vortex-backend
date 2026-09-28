import { Module, forwardRef } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IntentsService } from "./intents.service";
import { IntentsController } from "./intents.controller";
import { IntentsGateway } from "./intents.gateway";
import { IntentsSweeperService } from "./intents-sweeper.service";
import { IntentsMaintenanceJobs } from "./intents-maintenance.jobs";
import { INTENTS_REPOSITORY, InMemoryIntentsRepository } from "./intents.repository";
import { PrismaIntentsRepository } from "./prisma-intents.repository";
import { IntentCapabilityIndex } from "./solver-intent-matcher";
import { backplaneProvider } from "./backplane/backplane.factory";
import { backplaneHealthIndicator } from "./backplane/backplane-health.provider";
import { DualWriteIntentsRepository } from "./dual-write-intents.repository";
import { IntentsStoreVerifierService } from "./intents-store-verifier.service";
import { MetricsService } from "../metrics/metrics.service";
import { EvmModule } from "../chains/evm/evm.module";
import { SourceDepositVerificationService } from "./source-deposit-verification.service";
import { SolversModule } from "../solvers/solvers.module";
import { RoutingModule } from "../routing/routing.module";
import { TokensModule } from "../tokens/tokens.module";
import { SorobanModule } from "../soroban/soroban.module";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { GovernanceModule } from "../governance/governance.module";

@Module({
  // Both SolversModule and SorobanModule import IntentsModule back, so both
  // edges of each cycle must be deferred — a bare import resolves to `undefined`
  // when the peer module is still mid-initialization (AppModule reaches
  // SorobanModule through HealthModule before IntentsModule has finished).
  // `forwardRef` on the SorobanModule import mirrors the one in SorobanModule:
  // the two modules need each other (ShadowService here, IntentsService there).
  imports: [
    forwardRef(() => SolversModule),
    RoutingModule,
    TokensModule,
    forwardRef(() => SorobanModule),
    EvmModule,
  ],
  imports: [forwardRef(() => SolversModule), RoutingModule, TokensModule, SorobanModule, GovernanceModule, EvmModule],
  controllers: [IntentsController],
  providers: [
    // Select the intents store from INTENTS_STORE (issue #404):
    //   memory   → InMemoryIntentsRepository (default, dev/test)
    //   dual     → DualWriteIntentsRepository (memory reads, Postgres mirror)
    //   postgres → PrismaIntentsRepository (production)
    // See docs/runbooks/intents-store-migration.md for the cut-over steps.
    {
      provide: INTENTS_REPOSITORY,
      inject: [ConfigService, PrismaService, { token: MetricsService, optional: true }],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        prisma: PrismaService,
        metrics?: MetricsService,
      ) => {
        switch (config.get("intentsStore", { infer: true })) {
          case "postgres":
            return new PrismaIntentsRepository(prisma);
          case "dual":
            return new DualWriteIntentsRepository(
              new InMemoryIntentsRepository({ seed: false }),
              new PrismaIntentsRepository(prisma),
              metrics,
            );
          default:
            return new InMemoryIntentsRepository();
        }
      },
    },
    IntentsService,
    IntentCapabilityIndex,
    backplaneProvider,
    IntentsGateway,
    backplaneHealthIndicator,
    IntentsSweeperService,
    IntentsMaintenanceJobs,
    // Note: EventIngestionService is provided by SorobanModule (imported above)
    // and exported from there — no re-declaration needed here.
    IntentsStoreVerifierService,
    SourceDepositVerificationService,
  ],
  exports: [IntentsService, IntentsGateway, IntentCapabilityIndex],
})
export class IntentsModule {}
