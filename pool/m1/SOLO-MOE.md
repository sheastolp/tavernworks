# Tuned solo for MoE models (Nov 28)

`fx705-solo-moe.sh` runs the solo brain with:

- **Experts in RAM:** `-ngl 99 --n-cpu-moe N`. Attention, the shared
  expert, the output layer and the KV cache go on the 4 GB card; the
  experts of the first N blocks stay in RAM. `solo_moe_fit.py` picks N
  from the card's free memory at start. Put a number in
  `~/ai-pool/solo-cpu-moe.txt` to choose it yourself.
- **Batch checking:** the 0.8B draft (`Qwen3.5-0.8B-Q4_K_M.gguf` in
  `~/ai-pool`) guesses `POOL_SOLO_DRAFT_N` tokens (default 4). Put `off`
  in `~/ai-pool/solo-draft.txt` to turn it off.
- A failed load steps down: more experts in RAM, then no draft, then
  every expert in RAM.

The hand-edited `fx705-solo.sh` is untouched. The service switches to
the tuned script through a systemd drop-in, `ai-pool-solo-moe.conf`,
in `/etc/systemd/system/ai-pool-solo.service.d/`. Delete that file and
run `systemctl daemon-reload` to go back to plain solo.
