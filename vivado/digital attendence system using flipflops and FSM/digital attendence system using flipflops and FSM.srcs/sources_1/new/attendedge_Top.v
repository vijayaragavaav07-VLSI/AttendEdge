`timescale 1ns/1ps
// Basys3 top: ESP32-CAM --UART--> FPGA --UART--> ESP32-CAM
// ESP32 sends 1 byte = student index (0..62). FPGA replies 1 byte = status code.
module attendedge_top #(
    parameter CLKS_PER_BIT = 868,          // 100MHz / 115200
    parameter CLK_HZ       = 100_000_000
)(
    input  wire        clk,
    input  wire        btnC,               // reset
    input  wire        esp_rx,             // from ESP32 TX
    output wire        esp_tx,             // to ESP32 RX
    output wire [15:0] led
);
    wire reset = btnC;

    // ---- simple clock (starts 08:00:00 after reset). Replace with RTC later ----
    reg [31:0] tick = 0;
    reg [4:0]  hour = 5'd8;
    reg [5:0]  minute = 0, second = 0;
    always @(posedge clk) begin
        if (reset) begin tick<=0; hour<=5'd8; minute<=0; second<=0; end
        else if (tick == CLK_HZ-1) begin
            tick <= 0;
            if (second == 59) begin
                second <= 0;
                if (minute == 59) begin minute <= 0; hour <= (hour==23) ? 5'd0 : hour+1; end
                else minute <= minute + 1;
            end else second <= second + 1;
        end else tick <= tick + 1;
    end

    // ---- UART RX ----
    wire [7:0] rx_data; wire rx_valid;
    uart_rx #(.CLKS_PER_BIT(CLKS_PER_BIT)) u_rx (
        .clk(clk), .rst(reset), .rx(esp_rx), .data(rx_data), .valid(rx_valid));

    // ---- Controller ----
    wire        status_valid;
    wire [2:0]  status_code;
    wire [63:0] attendance_bits;
    wire [3:0]  state_dbg;
    attendance_controller u_attendance (
        .clk(clk), .reset(reset),
        .scan_valid(rx_valid),
        .capture_id((rx_data >= 8'd63) ? 6'd63 : rx_data[5:0]),
        .hour(hour), .minute(minute), .second(second),
        .status_valid(status_valid), .status_code(status_code),
        .attendance_bits(attendance_bits), .state_dbg(state_dbg));

    // ---- UART TX: report status ----
    reg       tx_start = 0;
    reg [7:0] tx_data  = 0;
    wire      tx_busy;
    always @(posedge clk) begin
        tx_start <= 1'b0;
        if (status_valid) begin tx_data <= {5'b0, status_code}; tx_start <= 1'b1; end
    end
    uart_tx #(.CLKS_PER_BIT(CLKS_PER_BIT)) u_tx (
        .clk(clk), .rst(reset), .start(tx_start), .data(tx_data),
        .tx(esp_tx), .busy(tx_busy));

    // ---- LEDs: [2:0] last status, [6:3] FSM state, [15:8] attendance_bits[7:0] ----
    reg [2:0] last_status = 0;
    always @(posedge clk) if (status_valid) last_status <= status_code;
    assign led = {attendance_bits[7:0], 1'b0, state_dbg, last_status};
endmodule