declare const process: { env: Record<string, string | undefined> };

export default async function handler(request: any, response: any) {
  const workflow_id = request.body?.input?.workflow_id
  const input = request.body?.input?.input

  console.log("Workflow ID:", workflow_id)
  console.log("Input:", input)

  if (!workflow_id) {
    return response.status(400).json({
      success: false,
      status: "failed",
      message: "workflow_id is required",
      data: null
    })
  }

  try {
    const hasuraUrl = process.env.NHOST_GRAPHQL_URL
    const adminSecret = process.env.NHOST_ADMIN_SECRET

    if (!hasuraUrl || !adminSecret) {
      throw new Error("Hasura URL or Admin Secret not configured")
    }

    // 1. Create workflow_run
    const createRunMutation = `
      mutation CreateWorkflowRun($workflow_id: uuid!, $input: jsonb) {
        insert_workflow_runs_one(object: {
          workflow_id: $workflow_id,
          trigger_type: "manual",
          input_payload: $input,
          status: "running"
        }) {
          id
        }
      }
    `

    const runResult = await fetch(hasuraUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hasura-admin-secret": adminSecret
      },
      body: JSON.stringify({
        query: createRunMutation,
        variables: {
          workflow_id,
          input: input || {}
        }
      })
    }).then(r => r.json())

    if (runResult.errors) {
      throw new Error(runResult.errors[0]?.message || "Failed to create workflow run")
    }

    const run_id = runResult.data.insert_workflow_runs_one.id
    console.log("Created workflow run:", run_id)

    // 2. Fetch workflow steps
    const stepsQuery = `
      query GetWorkflowSteps($workflow_id: uuid!) {
        workflow_steps(
          where: { workflow_id: { _eq: $workflow_id } }
          order_by: { position: asc }
        ) {
          id
          type
          config
          position
        }
      }
    `

    const stepsResult = await fetch(hasuraUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hasura-admin-secret": adminSecret
      },
      body: JSON.stringify({
        query: stepsQuery,
        variables: { workflow_id }
      })
    }).then(r => r.json())

    if (stepsResult.errors) {
      throw new Error(stepsResult.errors[0]?.message || "Failed to fetch steps")
    }

    const steps = stepsResult.data?.workflow_steps || []

    if (steps.length === 0) {
      return response.status(404).json({
        success: false,
        status: "failed",
        message: "No steps found for this workflow",
        data: null
      })
    }

    console.log("Found steps:", steps.length)

    // 3. Execute each step one by one
    let context = input || {}

    for (const step of steps) {
      console.log(`Executing step ${step.position}: ${step.type}`)

      // Create step_run
      const createStepRun = `
        mutation CreateStepRun($workflow_run_id: uuid!, $workflow_step_id: uuid!) {
          insert_step_runs_one(object: {
            workflow_run_id: $workflow_run_id,
            workflow_step_id: $workflow_step_id,
            status: "running"
          }) {
            id
          }
        }
      `

      const stepRunResult = await fetch(hasuraUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hasura-admin-secret": adminSecret
        },
        body: JSON.stringify({
          query: createStepRun,
          variables: { workflow_run_id: run_id, workflow_step_id: step.id }
        })
      }).then(r => r.json())

      const step_run_id = stepRunResult.data?.insert_step_runs_one?.id

      try {
        let output = {}

        // Step 0: LLM Call (GEMINI via env var)
        if (step.type === 'llm_call') {
          const geminiKey = process.env.GEMINI_API_KEY

          if (!geminiKey) {
            throw new Error("GEMINI_API_KEY not configured in environment variables")
          }

          const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              contents: [{
                parts: [{
                  text: step.config?.prompt || JSON.stringify(context)
                }]
              }]
            })
          })

          const aiData = await geminiResponse.json()

          if (aiData.error) {
            throw new Error(`Gemini API error: ${aiData.error.message}`)
          }

          output = {
            result: aiData.candidates?.[0]?.content?.parts?.[0]?.text || 'No response',
            raw: aiData
          }
        }

        // Step 1: HTTP Request
        else if (step.type === 'http_request') {
          const url = step.config?.url || 'https://httpbin.org/get'
          const method = step.config?.method || 'GET'

          const httpResponse = await fetch(url, { method })
          output = { status: httpResponse.status, body: await httpResponse.json() }
        }

        // Step 2: Conditional Branch
        else if (step.type === 'conditional_branch') {
          const condition = step.config?.condition || 'true'
          output = { condition_met: true, branch: 'yes', evaluated: condition }
        }

        // Step 3: Approval Gate
        else if (step.type === 'approval_gate') {
          // Update step_run as pending
          await fetch(hasuraUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-hasura-admin-secret": adminSecret
            },
            body: JSON.stringify({
              query: `
                mutation UpdateStepRun($id: uuid!, $status: String!) {
                  update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: $status}) {
                    id
                  }
                }
              `,
              variables: {
                id: step_run_id,
                status: "pending_approval"
              }
            })
          })

          // Update workflow_run as awaiting_approval
          await fetch(hasuraUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-hasura-admin-secret": adminSecret
            },
            body: JSON.stringify({
              query: `
                mutation UpdateWorkflowRun($id: uuid!, $status: String!, $output: jsonb) {
                  update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: $status, output_payload: $output}) {
                    id
                  }
                }
              `,
              variables: {
                id: run_id,
                status: "awaiting_approval",
                output: context
              }
            })
          })

          return response.status(200).json({
            success: true,
            status: "awaiting_approval",
            message: "Workflow paused for approval",
            data: JSON.stringify({ run_id, step_id: step.id, context })
          })
        }

        // Step 4: DB Write
        else if (step.type === 'db_write') {
          const saveResult = await fetch(hasuraUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-hasura-admin-secret": adminSecret
            },
            body: JSON.stringify({
              query: `
                mutation SaveResult($run_id: uuid!, $data: jsonb!) {
                  insert_workflow_results_one(object: {run_id: $run_id, result_data: $data}) {
                    id
                  }
                }
              `,
              variables: {
                run_id,
                data: context
              }
            })
          }).then(r => r.json())

          output = { saved: true, result_id: saveResult.data?.insert_workflow_results_one?.id }
        }

        // Step 5: Notify
        else if (step.type === 'notify') {
          console.log("NOTIFY:", step.config?.message || "Workflow completed")
          output = { notified: true, channel: step.config?.channel || 'console' }
        }

        // Mark step as completed
        await fetch(hasuraUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-hasura-admin-secret": adminSecret
          },
          body: JSON.stringify({
            query: `
              mutation UpdateStepRun($id: uuid!, $status: String!, $output: jsonb) {
                update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: $status, output: $output}) {
                  id
                }
              }
            `,
            variables: {
              id: step_run_id,
              status: "completed",
              output: output
            }
          })
        })

        // Pass output to next step
        context = { ...context, [step.type]: output }

      } catch (stepError: any) {
        // Mark step as failed
        await fetch(hasuraUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-hasura-admin-secret": adminSecret
          },
          body: JSON.stringify({
            query: `
              mutation UpdateStepRun($id: uuid!, $status: String!, $error: String) {
                update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: $status, error: $error}) {
                  id
                }
              }
            `,
            variables: {
              id: step_run_id,
              status: "failed",
              error: stepError.message
            }
          })
        })

        throw stepError
      }
    }

    // All steps completed
    await fetch(hasuraUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hasura-admin-secret": adminSecret
      },
      body: JSON.stringify({
        query: `
          mutation UpdateWorkflowRun($id: uuid!, $status: String!, $output: jsonb) {
            update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: $status, output_payload: $output}) {
              id
            }
          }
        `,
        variables: {
          id: run_id,
          status: "completed",
          output: context
        }
      })
    })

    return response.status(200).json({
      success: true,
      status: "completed",
      message: "Workflow completed successfully",
      data: JSON.stringify({
        run_id,
        workflow_id,
        context
      })
    })

  } catch (error: any) {
    console.error("Workflow error:", error)

    return response.status(500).json({
      success: false,
      status: "failed",
      message: error?.message || "Workflow engine failed",
      data: null
    })
  }
}

