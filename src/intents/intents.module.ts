import { Module, forwardRef } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IntentsService } from "./intents.service";
import { IntentsController } from "./intents.controller";
import { IntentsGateway } from "./intents.gateway";
import { IntentsSweeperService } from "./intents-sweeper.service";
import { INTENTS_REPOSITORY, InMemoryIntentsRepository } from "./intents.repository";
import { PrismaIntentsRepository } from "./prisma-intents.repository";
import { DualWriteIntentsRepository } from "./dual-write-intents.repository";
import { IntentsStoreVerifierService } from "./intents-store-verifier.service";
import { MetricsService } from "../metrics/metrics.service";
import { SolversModule } from "../solvers/solvers.module";
import { RoutingModule } from "../routing/routing.module";
import { TokensModule } from "../tokens/tokens.module";
import { SorobanModule } from "../soroban/soroban.module";
import { EventIngestionService } from "../soroban/event-ingestion.service";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";

@Module({
  imports: [forwardRef(() => SolversModule), RoutingModule, TokensModule, forwardRef(() => SorobanModule)],
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
    IntentsGateway,
    IntentsSweeperService,
    IntentsStoreVerifierService,
    EventIngestionService,
  ],
  exports: [IntentsService, IntentsGateway],
})
export class IntentsModule {}
