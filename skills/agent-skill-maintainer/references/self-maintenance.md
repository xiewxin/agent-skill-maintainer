# Self-maintenance

When this Skill is the target, the currently installed stable version remains the controller and the candidate stays in an isolated repository checkout.

The candidate cannot approve its own implementation, PR, merge, release, update, or cleanup. Use the stable controller to verify candidate outputs and permit at most one self-improvement iteration per invocation.

After an official release is verified, ask whether to update through the original installation method. Do not hot-swap the Skill during the current task; a new task may use the updated version.
