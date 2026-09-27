import { Module, forwardRef } from "@nestjs/common";
import { EventIngestionService } from "./event-ingestion.service";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";
import { SolverRegistryService } from "./solver-registry.service";
import { SignerService } from "./signer.service";
import { StellarTxService } from "./stellar-tx.service";
import { SolversModule } from "../solvers/solvers.module";

@Module({
  // EventIngestionService needs SolversService; SolversModule → IntentsModule →
  // SorobanModule is a cycle, hence forwardRef.
  imports: [forwardRef(() => SolversModule)],
  controllers: [SorobanController],
  providers: [
    SorobanService,
    SolverRegistryService,
    SignerService,
    StellarTxService,
    EventIngestionService,
  ],
  exports: [
    SorobanService,
    SolverRegistryService,
    SignerService,
    StellarTxService,
    EventIngestionService,
  ],
})
export class SorobanModule {}
