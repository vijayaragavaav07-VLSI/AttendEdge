`timescale 1ns/1ps
// 9-state attendance FSM
module attendance_controller (
    input  wire        clk,
    input  wire        reset,
    input  wire        scan_valid,        // 1-cycle pulse: new roll number
    input  wire [5:0]  capture_id,        // 0..62 valid, 63 = unregistered
    input  wire [4:0]  hour,
    input  wire [5:0]  minute,
    input  wire [5:0]  second,
    output reg         status_valid    = 1'b0,
    output reg  [2:0]  status_code     = 3'd0,
    output reg  [63:0] attendance_bits = 64'd0,
    output wire [3:0]  state_dbg          // FSM state, visible in waveform
);
    // state numbers match the waveform: 1..9
    localparam IDLE=4'd1, RECEIVE=4'd2, CHECK_TIME=4'd3, VERIFY=4'd4,
               CHECK_DUP=4'd5, RECORD=4'd6, INVALID=4'd7,
               ALREADY_PRESENT=4'd8, REPORT=4'd9;

    // status codes sent in REPORT
    localparam S_NONE=3'd0, S_ALREADY=3'd1, S_BAD_ID=3'd2,
               S_OUT_WINDOW=3'd3, S_RECORDED=3'd4;

    reg [3:0] state_reg = 4'd1;   // starts in IDLE
    reg [5:0] id_r = 6'd0;
    reg [4:0] h_r = 5'd0;
    reg [5:0] m_r = 6'd0;
    reg [2:0] result = 3'd0;

    assign state_dbg = state_reg;

    wire in_window = (h_r == 5'd8) && (m_r <= 6'd35);   // 08:00 - 08:35
    wire id_ok     = (id_r < 6'd63);                    // 63 students

    always @(posedge clk) begin
        if (reset) begin
            state_reg <= IDLE; id_r <= 0; h_r <= 0; m_r <= 0;
            result <= S_NONE; status_code <= S_NONE;
            status_valid <= 1'b0; attendance_bits <= 64'd0;
        end else begin
            status_valid <= 1'b0;
            case (state_reg)
                IDLE: if (scan_valid) begin
                    id_r <= capture_id; h_r <= hour; m_r <= minute;
                    state_reg <= RECEIVE;
                end
                RECEIVE:    state_reg <= CHECK_TIME;
                CHECK_TIME: if (in_window) state_reg <= VERIFY;
                            else begin result <= S_OUT_WINDOW; state_reg <= INVALID; end
                VERIFY:     if (id_ok) state_reg <= CHECK_DUP;
                            else begin result <= S_BAD_ID; state_reg <= INVALID; end
                CHECK_DUP:  state_reg <= attendance_bits[id_r] ? ALREADY_PRESENT : RECORD;
                RECORD: begin
                    attendance_bits[id_r] <= 1'b1;
                    result <= S_RECORDED;
                    state_reg <= REPORT;
                end
                INVALID:         state_reg <= REPORT;
                ALREADY_PRESENT: begin result <= S_ALREADY; state_reg <= REPORT; end
                REPORT: begin
                    status_code  <= result;
                    status_valid <= 1'b1;
                    state_reg <= IDLE;
                end
                default: state_reg <= IDLE;
            endcase
        end
    end
endmodule