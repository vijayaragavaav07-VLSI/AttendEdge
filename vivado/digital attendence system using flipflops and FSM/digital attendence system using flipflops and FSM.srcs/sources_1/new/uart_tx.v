`timescale 1ns/1ps
module uart_tx #(parameter CLKS_PER_BIT = 868)(
    input  wire       clk,
    input  wire       rst,
    input  wire       start,
    input  wire [7:0] data,
    output reg        tx,
    output wire       busy
);
    reg [1:0]  s = 0;
    reg [15:0] cnt = 0;
    reg [2:0]  idx = 0;
    reg [7:0]  d = 0;
    initial tx = 1'b1;
    assign busy = (s != 0);

    always @(posedge clk) begin
        if (rst) begin s <= 0; cnt <= 0; idx <= 0; tx <= 1'b1; end
        else case (s)
            0: begin tx <= 1'b1;
                 if (start) begin d <= data; cnt <= 0; s <= 1; end end
            1: begin tx <= 1'b0;                                      // start bit
                 if (cnt == CLKS_PER_BIT-1) begin cnt <= 0; idx <= 0; s <= 2; end
                 else cnt <= cnt + 1; end
            2: begin tx <= d[idx];                                    // data bits
                 if (cnt == CLKS_PER_BIT-1) begin
                     cnt <= 0;
                     if (idx == 7) s <= 3; else idx <= idx + 1;
                 end else cnt <= cnt + 1; end
            3: begin tx <= 1'b1;                                      // stop bit
                 if (cnt == CLKS_PER_BIT-1) begin cnt <= 0; s <= 0; end
                 else cnt <= cnt + 1; end
        endcase
    end
endmodule