<!-- Copyright (c) 2026 JoltWare
     SPDX-License-Identifier: Apache-2.0 -->

# Stateflow import example: gear shift logic

`gear_logic.slx` is a Simulink model (saved with MATLAB R2021a) containing the Stateflow chart
`Gear_Logic`. It is a simplified four-gear automatic transmission controller: one parallel state keeps the
current gear, and the other decides when to shift up or down from the speed and two thresholds.

It is used in the user manual (*Import and Export*, "Example: a gear shift chart") and by the test suite.
`Gear_Logic.machina` is the result of importing it with **MachinaState: Import PlantUML, SCXML, Mermaid or
Stateflow State Machine**.

## Source and license

The model is unmodified from
[mesh-iit/training-matlab-rev-lights](https://github.com/mesh-iit/training-matlab-rev-lights)
(`1_Gear_logic/gear_logic.slx`, commit `79e3946f02e83556b09aae5efae7c78b24f1e49d`):

- Copyright (c) 2021, iCub Tech.
- BSD 3-Clause License; the license text is in [LICENSE](LICENSE) in this folder. It applies to
  `gear_logic.slx` only; the rest of this repository is licensed under Apache 2.0.

That project's README says its chart is a simplified version of MathWorks' *Automatic Transmission
Controller* example.
