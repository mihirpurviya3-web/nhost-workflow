export default async function handler(request: any, response: any) {
  const workflow_id = request.body?.input?.workflow_id
  const input = request.body?.input?.input

  console.log("Workflow ID:", workflow_id)
  console.log("Input:", input)
  console.log("API Key configured:", !!process.env.OPENAI_API_KEY)

  if (!workflow_id) {
    console.log("Workflow ID is required")
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

    console.log("Hasura URL configured:", !!hasuraUrl)
    console.log("Admin secret configured:", !!adminSecret)

    if (!hasuraUrl) {
      throw new Error("NHOST_GRAPHQL_URL is not configured")
    }

    if (!adminSecret) {
      throw new Error("NHOST_ADMIN_SECRET is not configured")
    }

    // 1. Create workflow_run record
    const createRunMutation = `
      mutation CreateWorkflowRun($workflow_id: uuid!, $input: jsonb) {
        insert_workflow_runs_one(object: {
          workflow_id: $workflow_id,
          // trigger_type: "manual",
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

    // 2. Fetch workflow steps from database
    const stepsQuery = `
      query GetWorkflowSteps($workflow_id: uuid!) {
        workflow_steps(
          where: { workflow_id: { _eq: $workflow_id } }
          order_by: { step_order: asc }
        ) {
          id
          step_type
          step_config
          step_order
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

    console.log("Hasura steps response:", JSON.stringify(stepsResult))

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
      console.log(`Executing step ${step.step_order}: ${step.step_type}`)

      // Create step_run record
      const createStepRun = `
        mutation CreateStepRun($run_id: uuid!, $step_id: uuid!) {
          insert_step_runs_one(object: {
            run_id: $run_id,
            step_id: $step_id,
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
          variables: { run_id, step_id: step.id }
        })
      }).then(r => r.json())

      const step_run_id = stepRunResult.data?.insert_step_runs_one?.id

      try {
        let output = {}

        // Step 0: LLM Call
        if (step.step_type === 'llm_call') {
          const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              messages: [
                { role: 'system', content: step.step_config?.system_prompt || 'You are a helpful assistant' },
                { role: 'user', content: step.step_config?.prompt || JSON.stringify(context) }
              ]
            })
          })

          const aiData = await openaiResponse.json()
          output = { 
            result: aiData.choices?.[0]?.message?.content || 'No response',
            raw: aiData 
          }
        } 
        
        // Step 1: HTTP Request
        else if (step.step_type === 'http_request') {
          const url = step.step_config?.url || 'https://httpbin.org/get'
          const method = step.step_config?.method || 'GET'
          
          const httpResponse = await fetch(url, { method })
          output = { status: httpResponse.status, body: await httpResponse.json() }
        }
        
        // Step 2: Conditional Branch
        else if (step.step_type === 'conditional_branch') {
          const condition = step.step_config?.condition || 'true'
          output = { condition_met: true, branch: 'yes', evaluated: condition }
        }
        
        // Step 3: Approval Gate
        else if (step.step_type === 'approval_gate') {
          // Update step_run as pending
          await fetch(hasuraUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-hasura-admin-secret": adminSecret
            },
            body: JSON.stringify({
              query: `
                mutation UpdateStepRun($id: uuid!, $status: String!, $output: jsonb) {
                  update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: $status, output_payload: $output}) {
                    id
                  }
                }
              `,
              variables: {
                id: step_run_id,
                status: "pending_approval",
                output: { status: "awaiting approval" }
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
                mutation UpdateWorkflowRun($id: uuid!, $status: String!) {
                  update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: $status}) {
                    id
                  }
                }
              `,
              variables: {
                id: run_id,
                status: "awaiting_approval"
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
        else if (step.step_type === 'db_write') {
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
        else if (step.step_type === 'notify') {
          console.log("NOTIFY:", step.step_config?.message || "Workflow completed")
          output = { notified: true, channel: step.step_config?.channel || 'console' }
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
                update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: $status, output_payload: $output, completed_at: "now()"}) {
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
        context = { ...context, [step.step_type]: output }

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
                update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: $status, error_message: $error}) {
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
            update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: $status, output_payload: $output, completed_at: "now()"}) {
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